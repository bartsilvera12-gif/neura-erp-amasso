import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Conteo físico de un depósito y los ajustes que salen de él.
 *
 * 1. Se abre el conteo de un depósito: queda la foto de lo que el sistema
 *    dice que hay de cada producto (`cantidad_sistema`).
 * 2. Se carga lo contado, de a poco si hace falta (borrador).
 * 3. Al cerrarlo, cada diferencia se ajusta: el depósito queda con lo contado
 *    y el total del producto se corrige por la diferencia. Cada ajuste es un
 *    movimiento `ajuste_manual` con quién, cuándo y por qué.
 *
 * La diferencia se calcula contra el stock del momento de CERRAR, no el de la
 * foto: si entre medio se vendió algo, ajustar contra la foto descontaría dos
 * veces lo vendido.
 *
 * Cerrar (ajustar) lo hace solo un administrador: es el único camino para
 * corregir stock a mano.
 */

export class ConteoError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new ConteoError("No hay conexión directa a Postgres.", 500);
  return p;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export type ConteoCabecera = {
  id: string;
  ubicacion_id: string;
  ubicacion_nombre: string;
  fecha: string;
  estado: "borrador" | "cerrado";
  observacion: string | null;
  cerrado_at: string | null;
  items_total: number;
  items_contados: number;
  items_con_diferencia: number;
};

export type ConteoItem = {
  id: string;
  producto_id: string;
  producto_nombre: string;
  sku: string | null;
  unidad_medida: string;
  clase_producto: string;
  stock_minimo: number;
  cantidad_sistema: number;
  cantidad_contada: number | null;
  motivo: string | null;
};

function tablas(schemaRaw: string) {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  return {
    tC: quoteSchemaTable(schema, "inventario_conteos"),
    tI: quoteSchemaTable(schema, "inventario_conteo_items"),
    tU: quoteSchemaTable(schema, "inventario_ubicaciones"),
    tSU: quoteSchemaTable(schema, "inventario_stock_ubicacion"),
    tP: quoteSchemaTable(schema, "productos"),
    tM: quoteSchemaTable(schema, "movimientos_inventario"),
  };
}

export async function listarConteos(schemaRaw: string, empresaId: string): Promise<ConteoCabecera[]> {
  const { tC, tI, tU } = tablas(schemaRaw);
  const { rows } = await pool().query<ConteoCabecera>(
    `SELECT c.id, c.ubicacion_id, u.nombre AS ubicacion_nombre, c.fecha::text, c.estado, c.observacion,
            c.cerrado_at::text,
            count(i.id)::int AS items_total,
            count(i.cantidad_contada)::int AS items_contados,
            count(*) FILTER (WHERE i.cantidad_contada IS NOT NULL AND i.cantidad_contada <> i.cantidad_sistema)::int
              AS items_con_diferencia
       FROM ${tC} c
       LEFT JOIN ${tU} u ON u.id = c.ubicacion_id
       LEFT JOIN ${tI} i ON i.conteo_id = c.id
      WHERE c.empresa_id = $1::uuid
      GROUP BY c.id, u.nombre
      ORDER BY c.fecha DESC, c.created_at DESC
      LIMIT 50`,
    [empresaId]
  );
  return rows;
}

/** Abre un conteo con la foto del stock actual de todos los productos activos. */
export async function abrirConteo(
  schemaRaw: string,
  empresaId: string,
  ubicacionId: string,
  usuarioId: string | null
): Promise<string> {
  const { tC, tI, tU, tSU, tP } = tablas(schemaRaw);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const u = await client.query<{ nombre: string; tipo: string }>(
      `SELECT nombre, tipo FROM ${tU} WHERE id = $1::uuid AND empresa_id = $2::uuid AND activo`,
      [ubicacionId, empresaId]
    );
    if (!u.rows[0]) throw new ConteoError("Depósito no encontrado o inactivo.", 404);
    const abierto = await client.query(
      `SELECT 1 FROM ${tC} WHERE empresa_id = $1::uuid AND ubicacion_id = $2::uuid AND estado = 'borrador'`,
      [empresaId, ubicacionId]
    );
    if (abierto.rows.length > 0) {
      throw new ConteoError(`Ya hay un conteo abierto de ${u.rows[0].nombre}. Terminalo antes de abrir otro.`, 409);
    }
    const c = await client.query<{ id: string }>(
      `INSERT INTO ${tC} (empresa_id, ubicacion_id, created_by) VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING id`,
      [empresaId, ubicacionId, usuarioId]
    );
    const conteoId = c.rows[0].id;
    await client.query(
      `INSERT INTO ${tI} (empresa_id, conteo_id, producto_id, cantidad_sistema)
       SELECT $1::uuid, $2::uuid, p.id, COALESCE(su.stock_actual, 0)
         FROM ${tP} p
         LEFT JOIN ${tSU} su
           ON su.producto_id = p.id AND su.ubicacion_id = $3::uuid AND su.empresa_id = p.empresa_id
        WHERE p.empresa_id = $1::uuid AND p.activo = true`,
      [empresaId, conteoId, ubicacionId]
    );
    await client.query("COMMIT");
    return conteoId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export async function detalleConteo(
  schemaRaw: string,
  empresaId: string,
  conteoId: string
): Promise<{ conteo: ConteoCabecera; items: ConteoItem[] }> {
  const { tI, tP } = tablas(schemaRaw);
  const cab = (await listarConteos(schemaRaw, empresaId)).find((c) => c.id === conteoId);
  if (!cab) throw new ConteoError("Conteo no encontrado.", 404);
  const { rows } = await pool().query<ConteoItem>(
    `SELECT i.id, i.producto_id, p.nombre AS producto_nombre, p.sku, p.unidad_medida,
            COALESCE(p.clase_producto, 'reventa') AS clase_producto,
            COALESCE(p.stock_minimo, 0)::float8 AS stock_minimo,
            i.cantidad_sistema::float8 AS cantidad_sistema,
            i.cantidad_contada::float8 AS cantidad_contada, i.motivo
       FROM ${tI} i JOIN ${tP} p ON p.id = i.producto_id
      WHERE i.conteo_id = $1::uuid AND i.empresa_id = $2::uuid
      ORDER BY p.nombre`,
    [conteoId, empresaId]
  );
  return { conteo: cab, items: rows };
}

/** Guarda lo contado (borrador). `cantidad_contada: null` = todavía no se contó. */
export async function guardarConteoItems(
  schemaRaw: string,
  empresaId: string,
  conteoId: string,
  items: { id: string; cantidad_contada: number | null; motivo?: string | null }[]
): Promise<void> {
  const { tC, tI } = tablas(schemaRaw);
  const est = await pool().query<{ estado: string }>(
    `SELECT estado FROM ${tC} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [conteoId, empresaId]
  );
  if (!est.rows[0]) throw new ConteoError("Conteo no encontrado.", 404);
  if (est.rows[0].estado !== "borrador") throw new ConteoError("El conteo ya está cerrado.", 409);
  for (const it of items) {
    const c = it.cantidad_contada == null ? null : Number(it.cantidad_contada);
    if (c != null && (!Number.isFinite(c) || c < 0)) throw new ConteoError("Las cantidades contadas no pueden ser negativas.");
    await pool().query(
      `UPDATE ${tI} SET cantidad_contada = $1::numeric, motivo = $2
        WHERE id = $3::uuid AND conteo_id = $4::uuid AND empresa_id = $5::uuid`,
      [c, it.motivo?.trim() ? it.motivo.trim().slice(0, 300) : null, it.id, conteoId, empresaId]
    );
  }
}

export type ResultadoCierre = {
  ajustes: number;
  /** Insumos (y el resto) que quedaron por debajo del stock mínimo. */
  bajo_minimo: { producto: string; cantidad: number; minimo: number; unidad: string; clase: string }[];
};

/**
 * Cierra el conteo y ajusta las diferencias. Los productos no contados quedan
 * como estaban. Exige motivo en cada diferencia (lo pide el requerimiento:
 * quién, cuándo y por qué).
 */
export async function cerrarConteo(
  schemaRaw: string,
  empresaId: string,
  conteoId: string,
  usuario: { id: string | null; nombre: string | null }
): Promise<ResultadoCierre> {
  const { tC, tI, tSU, tP, tM, tU } = tablas(schemaRaw);
  const tSUcorto = tSU.split(".").pop();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const c = await client.query<{ estado: string; ubicacion_id: string; fecha: string }>(
      `SELECT estado, ubicacion_id, fecha::text FROM ${tC} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [conteoId, empresaId]
    );
    if (!c.rows[0]) throw new ConteoError("Conteo no encontrado.", 404);
    if (c.rows[0].estado !== "borrador") throw new ConteoError("El conteo ya está cerrado.", 409);
    const ubicacionId = c.rows[0].ubicacion_id;
    const ubi = await client.query<{ nombre: string }>(`SELECT nombre FROM ${tU} WHERE id = $1::uuid`, [ubicacionId]);

    const items = await client.query<{
      producto_id: string; cantidad_contada: string; motivo: string | null;
      nombre: string; sku: string | null; costo: string; actual_ubi: string | null;
    }>(
      `SELECT i.producto_id, i.cantidad_contada::text, i.motivo, p.nombre, p.sku, p.costo_promedio::text AS costo,
              su.stock_actual::text AS actual_ubi
         FROM ${tI} i
         JOIN ${tP} p ON p.id = i.producto_id
         LEFT JOIN ${tSU} su ON su.producto_id = i.producto_id AND su.ubicacion_id = $3::uuid AND su.empresa_id = i.empresa_id
        WHERE i.conteo_id = $1::uuid AND i.empresa_id = $2::uuid AND i.cantidad_contada IS NOT NULL
        ORDER BY p.nombre
        FOR UPDATE OF p`,
      [conteoId, empresaId, ubicacionId]
    );

    const conDif = items.rows.filter((r) => Math.abs(Number(r.cantidad_contada) - Number(r.actual_ubi ?? 0)) > 1e-9);
    const sinMotivo = conDif.filter((r) => !r.motivo?.trim());
    if (sinMotivo.length > 0) {
      throw new ConteoError(
        `Falta el motivo de la diferencia en: ${sinMotivo.slice(0, 5).map((r) => r.nombre).join(", ")}${sinMotivo.length > 5 ? "…" : ""}.`
      );
    }

    const referencia = `CONTEO ${c.rows[0].fecha} · ${ubi.rows[0]?.nombre ?? ""}`.trim();
    for (const r of conDif) {
      const dif = r6(Number(r.cantidad_contada) - Number(r.actual_ubi ?? 0));
      await client.query(
        `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric)
         ON CONFLICT (empresa_id, producto_id, ubicacion_id)
           DO UPDATE SET stock_actual = ${tSUcorto}.stock_actual + EXCLUDED.stock_actual, updated_at = now()`,
        [empresaId, r.producto_id, ubicacionId, dif]
      );
      await client.query(
        `UPDATE ${tP} SET stock_actual = GREATEST(0, COALESCE(stock_actual, 0) + $1::numeric), updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [dif, r.producto_id, empresaId]
      );
      await client.query(
        `INSERT INTO ${tM} (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad, costo_unitario,
           origen, referencia, fecha, created_by, usuario_nombre, ubicacion_id, motivo)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'AJUSTE', $5::numeric, $6::numeric, 'ajuste_manual', $7, now(),
                 $8::uuid, $9, $10::uuid, $11)`,
        [empresaId, r.producto_id, r.nombre, r.sku ?? "", dif, Number(r.costo) || 0, referencia,
         usuario.id, usuario.nombre, ubicacionId, r.motivo]
      );
    }

    await client.query(
      `UPDATE ${tC} SET estado = 'cerrado', cerrado_por = $1::uuid, cerrado_at = now() WHERE id = $2::uuid`,
      [usuario.id, conteoId]
    );

    // Aviso de stock mínimo (pedido para los insumos de uso general; se avisa de
    // todo lo que tenga un mínimo cargado).
    const bajo = await client.query<{ nombre: string; stock: string; minimo: string; unidad: string; clase: string }>(
      `SELECT p.nombre, COALESCE(su.stock_actual, 0)::text AS stock, p.stock_minimo::text AS minimo,
              p.unidad_medida AS unidad, COALESCE(p.clase_producto, 'reventa') AS clase
         FROM ${tI} i
         JOIN ${tP} p ON p.id = i.producto_id
         LEFT JOIN ${tSU} su ON su.producto_id = p.id AND su.ubicacion_id = $3::uuid AND su.empresa_id = p.empresa_id
        WHERE i.conteo_id = $1::uuid AND i.empresa_id = $2::uuid
          AND COALESCE(p.stock_minimo, 0) > 0 AND COALESCE(su.stock_actual, 0) < p.stock_minimo
        ORDER BY (COALESCE(p.clase_producto, '') = 'insumo') DESC, p.nombre`,
      [conteoId, empresaId, ubicacionId]
    );

    await client.query("COMMIT");
    return {
      ajustes: conDif.length,
      bajo_minimo: bajo.rows.map((b) => ({
        producto: b.nombre, cantidad: Number(b.stock), minimo: Number(b.minimo), unidad: b.unidad, clase: b.clase,
      })),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}
