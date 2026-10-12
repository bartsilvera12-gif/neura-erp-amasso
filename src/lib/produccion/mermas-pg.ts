import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Mermas y devoluciones. Tienen solo dos destinos (requerimiento de Amasso):
 *
 *  - desecho: sale del stock y se pierde.
 *  - galleta molida: sale del stock y entra como producto intermedio (la
 *    galleta molida), que después se usa en otras formulaciones o se empaca.
 *
 * Una merma de producción no descuenta nada: lo que se tiró nunca entró al
 * stock (la orden suma solo lo que salió bien). Solo registra el destino y,
 * si va a galleta molida, la suma.
 */

export class MermaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type DestinoMerma = "desecho" | "galleta_molida";
export type OrigenMerma = "merma" | "devolucion" | "vencimiento" | "produccion";

export type RegistrarMermaInput = {
  productoId: string;
  cantidad: number;
  ubicacionId: string;
  origen: OrigenMerma;
  destino: DestinoMerma;
  /** Para galleta molida: qué producto intermedio entra y cuánto (por defecto, la misma cantidad). */
  productoDestinoId?: string | null;
  cantidadDestino?: number | null;
  motivo?: string | null;
  produccionId?: string | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
};

type Q = { query: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Corre dentro de una transacción ya abierta (la de finalizar una orden) o en una propia. */
export async function registrarMermaEnTx(client: Q, schemaRaw: string, empresaId: string, d: RegistrarMermaInput) {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tP = quoteSchemaTable(schema, "productos");
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tMe = quoteSchemaTable(schema, "inventario_mermas");
  const suCorto = tSU.split(".").pop();

  const cantidad = r6(Number(d.cantidad));
  if (!(cantidad > 0)) throw new MermaError("La cantidad de la merma tiene que ser mayor a cero.");
  if (d.destino !== "desecho" && d.destino !== "galleta_molida") throw new MermaError("Destino inválido.");
  if (!d.ubicacionId) throw new MermaError("Indicá el depósito.");

  const prod = await client.query(
    `SELECT id, nombre, sku, costo_promedio FROM ${tP} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [d.productoId, empresaId]
  );
  const p = prod.rows[0] as { id: string; nombre: string; sku: string | null; costo_promedio: string } | undefined;
  if (!p) throw new MermaError("Producto no encontrado.", 404);

  // Sale del stock salvo que sea merma de producción (nunca entró).
  if (d.origen !== "produccion") {
    const hay = await client.query(
      `SELECT stock_actual FROM ${tSU} WHERE empresa_id = $1::uuid AND producto_id = $2::uuid AND ubicacion_id = $3::uuid FOR UPDATE`,
      [empresaId, d.productoId, d.ubicacionId]
    );
    const disponible = Number(hay.rows[0]?.stock_actual ?? 0);
    if (disponible + 1e-9 < cantidad) {
      throw new MermaError(`En ese depósito hay ${disponible} de "${p.nombre}" y la merma es de ${cantidad}.`, 409);
    }
    await client.query(
      `UPDATE ${tSU} SET stock_actual = stock_actual - $1::numeric, updated_at = now()
        WHERE empresa_id = $2::uuid AND producto_id = $3::uuid AND ubicacion_id = $4::uuid`,
      [cantidad, empresaId, d.productoId, d.ubicacionId]
    );
    await client.query(
      `UPDATE ${tP} SET stock_actual = GREATEST(0, COALESCE(stock_actual, 0) - $1::numeric), updated_at = now()
        WHERE id = $2::uuid AND empresa_id = $3::uuid`,
      [cantidad, d.productoId, empresaId]
    );
    await client.query(
      `INSERT INTO ${tM} (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad, costo_unitario,
         origen, referencia, fecha, created_by, usuario_nombre, ubicacion_id, motivo, produccion_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'SALIDA', $5::numeric, $6::numeric, 'ajuste_manual', $7, now(),
               $8::uuid, $9, $10::uuid, $11, $12::uuid)`,
      [empresaId, p.id, p.nombre, p.sku ?? "", cantidad, Number(p.costo_promedio) || 0,
       d.destino === "desecho" ? "Merma › desecho" : "Merma › galleta molida",
       d.usuarioId, d.usuarioNombre, d.ubicacionId, d.motivo ?? `${d.origen}`, d.produccionId ?? null]
    );
  }

  // Galleta molida: entra el intermedio, valuado al costo de lo que se recupera.
  let destinoId: string | null = null;
  let cantDestino: number | null = null;
  if (d.destino === "galleta_molida") {
    destinoId = d.productoDestinoId ?? null;
    if (!destinoId) throw new MermaError("Elegí el producto de galleta molida al que va la merma.");
    cantDestino = r6(Number(d.cantidadDestino ?? cantidad));
    if (!(cantDestino > 0)) throw new MermaError("La cantidad de galleta molida tiene que ser mayor a cero.");
    const dest = await client.query(
      `SELECT id, nombre, sku, stock_actual, costo_promedio FROM ${tP}
        WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [destinoId, empresaId]
    );
    const g = dest.rows[0] as { id: string; nombre: string; sku: string | null; stock_actual: string; costo_promedio: string } | undefined;
    if (!g) throw new MermaError("El producto de galleta molida no existe.", 404);

    // Costo que trae: lo que valía lo recuperado, repartido en lo que se obtuvo.
    const costoEntrada = r6((cantidad * (Number(p.costo_promedio) || 0)) / cantDestino);
    const stockAnt = Number(g.stock_actual) || 0;
    const costoNuevo = stockAnt + cantDestino > 0
      ? r6((stockAnt * (Number(g.costo_promedio) || 0) + cantDestino * costoEntrada) / (stockAnt + cantDestino))
      : costoEntrada;
    await client.query(
      `UPDATE ${tP} SET stock_actual = COALESCE(stock_actual, 0) + $1::numeric, costo_promedio = $2::numeric, updated_at = now()
        WHERE id = $3::uuid AND empresa_id = $4::uuid`,
      [cantDestino, costoNuevo, destinoId, empresaId]
    );
    await client.query(
      `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric)
       ON CONFLICT (empresa_id, producto_id, ubicacion_id)
         DO UPDATE SET stock_actual = ${suCorto}.stock_actual + EXCLUDED.stock_actual, updated_at = now()`,
      [empresaId, destinoId, d.ubicacionId, cantDestino]
    );
    await client.query(
      `INSERT INTO ${tM} (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad, costo_unitario,
         origen, referencia, fecha, created_by, usuario_nombre, ubicacion_id, motivo, produccion_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'ENTRADA', $5::numeric, $6::numeric, 'produccion', $7, now(),
               $8::uuid, $9, $10::uuid, $11, $12::uuid)`,
      [empresaId, g.id, g.nombre, g.sku ?? "", cantDestino, costoEntrada, `Desde merma de ${p.nombre}`,
       d.usuarioId, d.usuarioNombre, d.ubicacionId, d.motivo ?? null, d.produccionId ?? null]
    );
  }

  const ins = await client.query(
    `INSERT INTO ${tMe} (empresa_id, producto_id, producto_nombre, cantidad, ubicacion_id, origen, destino,
       producto_destino_id, cantidad_destino, produccion_id, motivo, created_by, usuario_nombre)
     VALUES ($1::uuid, $2::uuid, $3, $4::numeric, $5::uuid, $6, $7, $8::uuid, $9::numeric, $10::uuid, $11, $12::uuid, $13)
     RETURNING id`,
    [empresaId, p.id, p.nombre, cantidad, d.ubicacionId, d.origen, d.destino, destinoId, cantDestino,
     d.produccionId ?? null, d.motivo?.trim() || null, d.usuarioId, d.usuarioNombre]
  );
  return { id: String(ins.rows[0].id) };
}

export async function registrarMerma(schemaRaw: string, empresaId: string, d: RegistrarMermaInput) {
  const pool = getChatPostgresPool();
  if (!pool) throw new MermaError("No hay conexión directa a Postgres.", 500);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await registrarMermaEnTx(client as unknown as Q, schemaRaw, empresaId, d);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export type MermaFila = {
  id: string;
  fecha: string;
  producto_nombre: string;
  cantidad: number;
  origen: OrigenMerma;
  destino: DestinoMerma;
  destino_nombre: string | null;
  cantidad_destino: number | null;
  ubicacion_nombre: string | null;
  motivo: string | null;
  usuario_nombre: string | null;
};

export async function listarMermas(schemaRaw: string, empresaId: string, limite = 100): Promise<MermaFila[]> {
  const pool = getChatPostgresPool();
  if (!pool) throw new MermaError("No hay conexión directa a Postgres.", 500);
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tMe = quoteSchemaTable(schema, "inventario_mermas");
  const tP = quoteSchemaTable(schema, "productos");
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");
  const { rows } = await pool.query<MermaFila>(
    `SELECT m.id, m.created_at::text AS fecha, m.producto_nombre, m.cantidad::float8 AS cantidad, m.origen, m.destino,
            d.nombre AS destino_nombre, m.cantidad_destino::float8 AS cantidad_destino, u.nombre AS ubicacion_nombre,
            m.motivo, m.usuario_nombre
       FROM ${tMe} m
       LEFT JOIN ${tP} d ON d.id = m.producto_destino_id
       LEFT JOIN ${tU} u ON u.id = m.ubicacion_id
      WHERE m.empresa_id = $1::uuid
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [empresaId, limite]
  );
  return rows;
}
