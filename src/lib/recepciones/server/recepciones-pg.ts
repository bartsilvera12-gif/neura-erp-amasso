import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { recalcularEstadoOrdenEnTx } from "@/lib/ordenes/server/ordenes-pg";

/**
 * Recepciones — movimiento FÍSICO. Aumentan stock exactamente una vez y NO
 * generan asiento contable ni Libro de Compras. Lo recibido queda "pendiente de
 * facturar" hasta que una compra lo consuma.
 */

export class RecepcionError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

export interface RecepcionItemInput {
  orden_item_id: string;
  cantidad_recibida: number;
  costo_unitario_recibido: number;
}

export interface RecepcionInput {
  orden_id: string;
  fecha: string;
  ubicacion_id: string | null;
  observacion: string | null;
  documento_url: string | null;
  items: RecepcionItemInput[];
  permitir_excedente: boolean;
  motivo_excedente: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  usuario_nombre: string | null;
}

export interface RecepcionRow {
  id: string; numero: string; orden_id: string; orden_numero?: string | null;
  proveedor_id: string | null; proveedor_nombre: string | null;
  fecha: string; ubicacion_id: string | null; ubicacion_nombre?: string | null;
  observacion: string | null; documento_url: string | null;
  estado: string; estado_facturacion: string;
  excedente_confirmado: boolean; motivo_excedente: string | null;
  usuario_nombre: string | null; created_at: string;
  cant_recibida?: number; cant_facturada?: number; cant_pend_facturar?: number;
}

const REC_COLS = `r.id, r.numero, r.orden_id, r.proveedor_id, r.proveedor_nombre, r.fecha,
  r.ubicacion_id, r.observacion, r.documento_url, r.estado, r.estado_facturacion,
  r.excedente_confirmado, r.motivo_excedente, r.usuario_nombre, r.created_at`;

export async function listRecepciones(
  schemaRaw: string, empresaId: string,
  f: { orden_id?: string | null; estado_facturacion?: string | null; desde?: string | null; hasta?: string | null } = {}
): Promise<RecepcionRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tR = quoteSchemaTable(schema, "recepciones");
  const tRI = quoteSchemaTable(schema, "recepcion_items");
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");
  const params: unknown[] = [empresaId];
  const where: string[] = ["r.empresa_id = $1::uuid"];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.orden_id) where.push(`r.orden_id = ${add(f.orden_id)}::uuid`);
  if (f.estado_facturacion) where.push(`r.estado_facturacion = ${add(f.estado_facturacion)}`);
  if (f.desde) where.push(`r.fecha >= ${add(f.desde)}::date`);
  if (f.hasta) where.push(`r.fecha <= ${add(f.hasta)}::date`);

  const { rows } = await pool().query(
    `SELECT ${REC_COLS}, o.numero AS orden_numero, u.nombre AS ubicacion_nombre,
            COALESCE(t.recibida,0) AS recibida, COALESCE(t.facturada,0) AS facturada
       FROM ${tR} r
       LEFT JOIN ${tO} o ON o.id = r.orden_id
       LEFT JOIN ${tU} u ON u.id = r.ubicacion_id
       LEFT JOIN LATERAL (
         SELECT SUM(ri.cantidad_recibida) AS recibida, SUM(ri.cantidad_facturada) AS facturada
           FROM ${tRI} ri WHERE ri.recepcion_id = r.id
       ) t ON true
      WHERE ${where.join(" AND ")}
      ORDER BY r.fecha DESC, r.numero DESC LIMIT 500`,
    params
  );
  return rows.map((r) => {
    const recibida = Number(r.recibida) || 0;
    const facturada = Number(r.facturada) || 0;
    return { ...(r as unknown as RecepcionRow), cant_recibida: recibida, cant_facturada: facturada,
             cant_pend_facturar: Math.max(0, recibida - facturada) };
  });
}

export interface RecepcionItemRow {
  id: string; orden_item_id: string | null; producto_id: string | null; producto_nombre: string | null;
  cantidad_recibida: string | number; costo_unitario_recibido: string | number;
  cantidad_facturada: string | number; movimiento_id: string | null;
  iva_tipo?: string | null; cuenta_contable_id?: string | null; costo_unitario_estimado?: string | number | null;
}

export async function getRecepcion(
  schemaRaw: string, empresaId: string, recepcionId: string
): Promise<{ recepcion: RecepcionRow; items: RecepcionItemRow[] } | null> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tR = quoteSchemaTable(schema, "recepciones");
  const tRI = quoteSchemaTable(schema, "recepcion_items");
  const tOCI = quoteSchemaTable(schema, "orden_compra_items");
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");

  const { rows } = await pool().query(
    `SELECT ${REC_COLS}, o.numero AS orden_numero, u.nombre AS ubicacion_nombre
       FROM ${tR} r LEFT JOIN ${tO} o ON o.id = r.orden_id LEFT JOIN ${tU} u ON u.id = r.ubicacion_id
      WHERE r.id = $1::uuid AND r.empresa_id = $2::uuid`,
    [recepcionId, empresaId]
  );
  if (!rows[0]) return null;
  const { rows: items } = await pool().query<RecepcionItemRow>(
    `SELECT ri.id, ri.orden_item_id, ri.producto_id, ri.producto_nombre, ri.cantidad_recibida,
            ri.costo_unitario_recibido, ri.cantidad_facturada, ri.movimiento_id,
            oi.iva_tipo, oi.cuenta_contable_id, oi.costo_unitario_estimado
       FROM ${tRI} ri LEFT JOIN ${tOCI} oi ON oi.id = ri.orden_item_id
      WHERE ri.recepcion_id = $1::uuid AND ri.empresa_id = $2::uuid
      ORDER BY ri.created_at`,
    [recepcionId, empresaId]
  );
  return { recepcion: rows[0] as RecepcionRow, items };
}

async function fetchByIdem(schema: string, empresaId: string, key: string): Promise<RecepcionRow | null> {
  const tR = quoteSchemaTable(schema, "recepciones");
  const { rows } = await pool().query(
    `SELECT ${REC_COLS} FROM ${tR} r WHERE r.empresa_id=$1::uuid AND r.idempotency_key=$2::uuid LIMIT 1`,
    [empresaId, key]
  );
  return (rows[0] as RecepcionRow) ?? null;
}

/**
 * Confirma una recepción en UNA sola transacción:
 *   recepción → ítems → 1 movimiento de inventario por producto → stock → estado de orden.
 * Vínculo fuerte: movimiento.documento_tipo='recepcion', documento_id=recepcion.id.
 * El índice único (empresa, documento_tipo, documento_id, producto_id) hace
 * imposible duplicar el movimiento aunque se reintente.
 */
export async function confirmarRecepcion(
  schemaRaw: string, empresaId: string, d: RecepcionInput
): Promise<RecepcionRow> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  if (!Array.isArray(d.items) || d.items.length === 0) throw new RecepcionError("Cargá al menos un ítem recibido.");
  for (const it of d.items) {
    if (!(Number(it.cantidad_recibida) > 0)) throw new RecepcionError("Las cantidades recibidas deben ser mayores a 0.");
    if (Number(it.costo_unitario_recibido) < 0) throw new RecepcionError("El costo recibido no puede ser negativo.");
  }
  if (d.idempotency_key) {
    const ex = await fetchByIdem(schema, empresaId, d.idempotency_key);
    if (ex) return ex;
  }

  const tR = quoteSchemaTable(schema, "recepciones");
  const tRI = quoteSchemaTable(schema, "recepcion_items");
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const tOCI = quoteSchemaTable(schema, "orden_compra_items");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // Orden: debe existir y estar en un estado que admita recepciones.
    const { rows: ord } = await client.query<{ id: string; estado: string; proveedor_id: string; proveedor_nombre: string }>(
      `SELECT id, estado, proveedor_id, proveedor_nombre FROM ${tO}
        WHERE id=$1::uuid AND empresa_id=$2::uuid FOR UPDATE`,
      [d.orden_id, empresaId]
    );
    if (!ord[0]) throw new RecepcionError("Orden de compra no encontrada.", 404);
    if (!["aprobada", "parcialmente_recibida", "recibida"].includes(ord[0].estado)) {
      throw new RecepcionError(`No se puede recibir sobre una orden en estado "${ord[0].estado}". Aprobá la orden primero.`, 409);
    }

    // Pendiente por ítem (solicitado − ya recibido en recepciones confirmadas).
    const ids = d.items.map((i) => i.orden_item_id);
    const { rows: pend } = await client.query<{ id: string; producto_id: string | null; producto_nombre: string | null; cantidad: string; recibida: string }>(
      `SELECT i.id, i.producto_id, i.producto_nombre, i.cantidad::text,
              COALESCE((SELECT SUM(ri.cantidad_recibida) FROM ${tRI} ri
                          JOIN ${tR} r2 ON r2.id=ri.recepcion_id AND r2.estado='confirmada'
                         WHERE ri.orden_item_id = i.id), 0)::text AS recibida
         FROM ${tOCI} i
        WHERE i.orden_id=$1::uuid AND i.empresa_id=$2::uuid AND i.id = ANY($3::uuid[])`,
      [d.orden_id, empresaId, ids]
    );
    if (pend.length !== new Set(ids).size) throw new RecepcionError("Algún ítem no pertenece a esta orden de compra.");
    const byId = new Map(pend.map((p) => [p.id, p]));

    let huboExcedente = false;
    for (const it of d.items) {
      const p = byId.get(it.orden_item_id)!;
      const pendiente = Number(p.cantidad) - Number(p.recibida);
      if (Number(it.cantidad_recibida) > pendiente) {
        if (!d.permitir_excedente) {
          throw new RecepcionError(
            `"${p.producto_nombre ?? "Ítem"}": estás recibiendo ${it.cantidad_recibida} y solo quedan ${pendiente} pendientes. Habilitá la recepción excedente si corresponde.`
          );
        }
        if (!d.motivo_excedente?.trim()) throw new RecepcionError("Indicá el motivo de la recepción excedente.");
        huboExcedente = true;
      }
    }

    const { rows: num } = await client.query<{ numero: string }>(
      `SELECT ${quoteSchemaTable(schema, "next_numero_recepcion_empresa")}($1::uuid) AS numero`, [empresaId]
    );

    let recepcion: RecepcionRow;
    try {
      const { rows } = await client.query(
        `INSERT INTO ${tR} (empresa_id, numero, orden_id, proveedor_id, proveedor_nombre, fecha, ubicacion_id,
           observacion, documento_url, estado, estado_facturacion, excedente_confirmado, motivo_excedente,
           idempotency_key, created_by, usuario_nombre)
         VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6::date,$7::uuid,$8,$9,'confirmada','pendiente',$10::boolean,$11,$12::uuid,$13::uuid,$14)
         RETURNING ${REC_COLS.replace(/r\./g, "")}`,
        [empresaId, num[0].numero, d.orden_id, ord[0].proveedor_id, ord[0].proveedor_nombre, d.fecha,
         d.ubicacion_id, d.observacion, d.documento_url, huboExcedente,
         huboExcedente ? (d.motivo_excedente ?? "").trim() : null,
         d.idempotency_key, d.created_by, d.usuario_nombre]
      );
      recepcion = rows[0] as RecepcionRow;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "23505" && String((e as { constraint?: string })?.constraint ?? "").includes("idem") && d.idempotency_key) {
        await client.query("ROLLBACK").catch(() => null);
        const ex = await fetchByIdem(schema, empresaId, d.idempotency_key);
        if (ex) return ex;
      }
      throw e;
    }

    // Un único movimiento por producto (el índice único lo garantiza). Se agrupan
    // las líneas del mismo producto para no chocar con esa restricción.
    const porProducto = new Map<string, { cantidad: number; costoPonderado: number; nombre: string }>();
    for (const it of d.items) {
      const p = byId.get(it.orden_item_id)!;
      if (!p.producto_id) continue; // línea sin producto: no impacta inventario
      const prev = porProducto.get(p.producto_id) ?? { cantidad: 0, costoPonderado: 0, nombre: p.producto_nombre ?? "" };
      prev.costoPonderado += Number(it.cantidad_recibida) * Number(it.costo_unitario_recibido);
      prev.cantidad += Number(it.cantidad_recibida);
      porProducto.set(p.producto_id, prev);
    }

    const movPorProducto = new Map<string, string>();
    for (const [productoId, agg] of porProducto) {
      const costoUnit = agg.cantidad > 0 ? agg.costoPonderado / agg.cantidad : 0;
      const { rows: mov } = await client.query<{ id: string }>(
        `INSERT INTO ${tM} (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
           costo_unitario, origen, referencia, fecha, created_by, usuario_nombre, documento_tipo, documento_id)
         SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku,''), 'ENTRADA', $4::numeric, $5::numeric,
                'recepcion', $6, now(), $7::uuid, $8, 'recepcion', $9::uuid
           FROM ${tP} p WHERE p.id = $2::uuid AND p.empresa_id = $1::uuid
         RETURNING id`,
        [empresaId, productoId, agg.nombre, agg.cantidad, costoUnit, recepcion.numero,
         d.created_by, d.usuario_nombre, recepcion.id]
      );
      if (!mov[0]?.id) throw new RecepcionError("No se pudo registrar el movimiento de inventario (producto inexistente).");
      movPorProducto.set(productoId, mov[0].id);

      const upd = await client.query(
        `UPDATE ${tP} SET stock_actual = COALESCE(stock_actual,0) + $1::numeric,
                          costo_promedio = $2::numeric, updated_at = now()
          WHERE id=$3::uuid AND empresa_id=$4::uuid`,
        [agg.cantidad, costoUnit, productoId, empresaId]
      );
      if (upd.rowCount === 0) throw new RecepcionError("No se pudo actualizar el stock del producto.");

      // Stock por ubicación (si el ERP la maneja y se indicó depósito).
      if (d.ubicacion_id) {
        await client.query(
          `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::numeric)
           ON CONFLICT (empresa_id, producto_id, ubicacion_id)
             DO UPDATE SET stock_actual = ${tSU.split(".").pop()}.stock_actual + EXCLUDED.stock_actual, updated_at = now()`,
          [empresaId, productoId, d.ubicacion_id, agg.cantidad]
        );
      }
    }

    for (const it of d.items) {
      const p = byId.get(it.orden_item_id)!;
      await client.query(
        `INSERT INTO ${tRI} (empresa_id, recepcion_id, orden_item_id, producto_id, producto_nombre,
           cantidad_recibida, costo_unitario_recibido, cantidad_facturada, movimiento_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::numeric,$7::numeric,0,$8::uuid)`,
        [empresaId, recepcion.id, it.orden_item_id, p.producto_id, p.producto_nombre,
         it.cantidad_recibida, it.costo_unitario_recibido,
         p.producto_id ? movPorProducto.get(p.producto_id) ?? null : null]
      );
    }

    await recalcularEstadoOrdenEnTx(client, schema, empresaId, d.orden_id);
    await client.query("COMMIT");
    return recepcion;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally { client.release(); }
}

/**
 * Recalcula estado_facturacion de una recepción (dentro de la tx de la compra).
 */
export async function recalcularFacturacionRecepcionEnTx(
  client: import("pg").PoolClient, schema: string, empresaId: string, recepcionId: string
): Promise<void> {
  const tR = quoteSchemaTable(schema, "recepciones");
  const tRI = quoteSchemaTable(schema, "recepcion_items");
  const { rows } = await client.query<{ recibida: string; facturada: string }>(
    `SELECT COALESCE(SUM(cantidad_recibida),0)::text AS recibida,
            COALESCE(SUM(cantidad_facturada),0)::text AS facturada
       FROM ${tRI} WHERE recepcion_id=$1::uuid AND empresa_id=$2::uuid`,
    [recepcionId, empresaId]
  );
  const rec = Number(rows[0]?.recibida ?? 0);
  const fac = Number(rows[0]?.facturada ?? 0);
  const estado = fac <= 0 ? "pendiente" : fac >= rec ? "facturada" : "parcial";
  await client.query(
    `UPDATE ${tR} SET estado_facturacion=$3, updated_at=now() WHERE id=$1::uuid AND empresa_id=$2::uuid`,
    [recepcionId, empresaId, estado]
  );
}

/**
 * Anula una recepción: saca del stock lo que entró (total y depósito) con un
 * movimiento de salida, y la orden vuelve a tener esas cantidades pendientes.
 *
 * No se puede si ya se facturó (primero se anula la compra) ni si ese stock ya
 * se usó o vendió (no se deja en negativo). El costo promedio que puso la
 * recepción no se recalcula hacia atrás.
 */
export async function anularRecepcion(
  schemaRaw: string,
  empresaId: string,
  id: string,
  motivo: string,
  usuario: { id: string | null; nombre: string | null }
): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  if (motivo.trim().length < 3) throw new RecepcionError("Escribí el motivo de la anulación.");
  const tR = quoteSchemaTable(schema, "recepciones");
  const tRI = quoteSchemaTable(schema, "recepcion_items");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: rec } = await client.query<{ numero: string; estado: string; orden_id: string; ubicacion_id: string | null; observacion: string | null }>(
      `SELECT numero, estado, orden_id, ubicacion_id, observacion FROM ${tR} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [id, empresaId]
    );
    const r = rec[0];
    if (!r) throw new RecepcionError("Recepción no encontrada.", 404);
    if (r.estado !== "confirmada") throw new RecepcionError("La recepción ya está anulada.", 409);
    const { rows: items } = await client.query<{ producto_id: string | null; producto_nombre: string | null; cantidad: string; facturada: string }>(
      `SELECT producto_id, producto_nombre, cantidad_recibida::text AS cantidad, COALESCE(cantidad_facturada, 0)::text AS facturada
         FROM ${tRI} WHERE recepcion_id = $1::uuid AND empresa_id = $2::uuid`,
      [id, empresaId]
    );
    if (items.some((i) => Number(i.facturada) > 0)) {
      throw new RecepcionError("Ya tiene compras facturadas. Anulá primero esas compras y después la recepción.", 409);
    }
    // Lo que entró, por producto.
    const porProducto = new Map<string, { cantidad: number; nombre: string }>();
    for (const i of items) {
      if (!i.producto_id) continue;
      const prev = porProducto.get(i.producto_id) ?? { cantidad: 0, nombre: i.producto_nombre ?? "" };
      prev.cantidad += Number(i.cantidad);
      porProducto.set(i.producto_id, prev);
    }
    for (const [productoId, agg] of porProducto) {
      const { rows: st } = await client.query<{ total: string; dep: string | null }>(
        `SELECT p.stock_actual::text AS total,
                (SELECT s.stock_actual::text FROM ${tSU} s
                  WHERE s.producto_id = p.id AND s.ubicacion_id = $3::uuid AND s.empresa_id = p.empresa_id) AS dep
           FROM ${tP} p WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid FOR UPDATE`,
        [productoId, empresaId, r.ubicacion_id]
      );
      const hay = r.ubicacion_id ? Number(st[0]?.dep ?? 0) : Number(st[0]?.total ?? 0);
      if (hay + 1e-9 < agg.cantidad) {
        throw new RecepcionError(
          `"${agg.nombre}": entraron ${agg.cantidad} y en el depósito quedan ${hay}. Ya se usó o vendió parte; no se puede anular la recepción.`,
          409
        );
      }
      await client.query(
        `INSERT INTO ${tM} (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
           costo_unitario, origen, referencia, fecha, created_by, usuario_nombre, documento_tipo, documento_id)
         SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''), 'SALIDA', $4::numeric, COALESCE(p.costo_promedio, 0),
                'anulacion', $5, now(), $6::uuid, $7, 'recepcion', $8::uuid
           FROM ${tP} p WHERE p.id = $2::uuid AND p.empresa_id = $1::uuid`,
        [empresaId, productoId, agg.nombre, agg.cantidad, `Anulación ${r.numero}`, usuario.id, usuario.nombre, id]
      );
      await client.query(
        `UPDATE ${tP} SET stock_actual = COALESCE(stock_actual, 0) - $1::numeric, updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [agg.cantidad, productoId, empresaId]
      );
      if (r.ubicacion_id) {
        await client.query(
          `UPDATE ${tSU} SET stock_actual = stock_actual - $1::numeric, updated_at = now()
            WHERE producto_id = $2::uuid AND ubicacion_id = $3::uuid AND empresa_id = $4::uuid`,
          [agg.cantidad, productoId, r.ubicacion_id, empresaId]
        );
      }
    }
    const obs = [r.observacion, `ANULADA: ${motivo.trim()}${usuario.nombre ? ` (${usuario.nombre})` : ""}`].filter(Boolean).join(" · ");
    await client.query(`UPDATE ${tR} SET estado = 'anulada', observacion = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid`, [
      id,
      empresaId,
      obs.slice(0, 1000),
    ]);
    await recalcularEstadoOrdenEnTx(client, schema, empresaId, r.orden_id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

/** Borra de la lista una recepción anulada (su stock ya se revirtió). */
export async function eliminarRecepcion(schemaRaw: string, empresaId: string, id: string): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tR = quoteSchemaTable(schema, "recepciones");
  const tRI = quoteSchemaTable(schema, "recepcion_items");
  const tCI = quoteSchemaTable(schema, "compra_items");
  const { rows } = await pool().query<{ estado: string }>(`SELECT estado FROM ${tR} WHERE id = $1::uuid AND empresa_id = $2::uuid`, [
    id,
    empresaId,
  ]);
  if (!rows[0]) throw new RecepcionError("Recepción no encontrada.", 404);
  if (rows[0].estado !== "anulada") throw new RecepcionError("Para borrarla, primero anulala.", 409);
  const comp = await pool().query(
    `SELECT 1 FROM ${tCI} ci JOIN ${tRI} ri ON ri.id = ci.recepcion_item_id WHERE ri.recepcion_id = $1::uuid LIMIT 1`,
    [id]
  );
  if (comp.rows.length) {
    throw new RecepcionError("Hay compras (aunque estén anuladas) que la referencian. Borrá primero esas compras.", 409);
  }
  await pool().query(`DELETE FROM ${tR} WHERE id = $1::uuid AND empresa_id = $2::uuid`, [id, empresaId]);
}

export interface EditarRecepcionInput {
  fecha?: unknown;
  observacion?: unknown;
  documento_url?: unknown;
  /** undefined = no cambia; null o "" = sin depósito. */
  ubicacion_id?: unknown;
  items?: { id: string; cantidad_recibida: unknown; costo_unitario_recibido: unknown }[];
}

/**
 * Edita una recepción confirmada: datos, depósito, cantidades y costos, en UNA
 * transacción. Lo que cambia en cantidad o depósito se refleja en el stock (total
 * y por depósito) con un movimiento "Corrección RC-…".
 *
 * Límites: una cantidad no puede quedar por debajo de lo ya facturado, ni por
 * encima de lo pedido en la orden (salvo que la recepción ya fuera excedente),
 * ni sacar del depósito stock que ya se usó o vendió. El costo promedio del
 * producto se actualiza solo si esta recepción fue su última entrada.
 */
export async function editarRecepcion(
  schemaRaw: string,
  empresaId: string,
  id: string,
  d: EditarRecepcionInput,
  usuario: { id: string | null; nombre: string | null }
): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tR = quoteSchemaTable(schema, "recepciones");
  const tRI = quoteSchemaTable(schema, "recepcion_items");
  const tOCI = quoteSchemaTable(schema, "orden_compra_items");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");

  const fecha = d.fecha != null && d.fecha !== "" ? String(d.fecha).slice(0, 10) : null;
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new RecepcionError("Fecha inválida.");
  const obs = d.observacion !== undefined ? String(d.observacion ?? "").trim().slice(0, 1000) || null : undefined;
  const doc = d.documento_url !== undefined ? String(d.documento_url ?? "").trim().slice(0, 1000) || null : undefined;

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: rec } = await client.query<{
      numero: string; estado: string; orden_id: string; ubicacion_id: string | null;
      excedente_confirmado: boolean; created_at: string;
    }>(
      `SELECT numero, estado, orden_id, ubicacion_id, excedente_confirmado, created_at
         FROM ${tR} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [id, empresaId]
    );
    const r = rec[0];
    if (!r) throw new RecepcionError("Recepción no encontrada.", 404);
    if (r.estado !== "confirmada") throw new RecepcionError("La recepción está anulada; no se puede editar.", 409);

    const ubicNueva =
      d.ubicacion_id === undefined ? r.ubicacion_id : d.ubicacion_id ? String(d.ubicacion_id) : null;
    if (ubicNueva && ubicNueva !== r.ubicacion_id) {
      const { rows: u } = await client.query(`SELECT 1 FROM ${tU} WHERE id = $1::uuid AND empresa_id = $2::uuid`, [
        ubicNueva,
        empresaId,
      ]);
      if (!u[0]) throw new RecepcionError("El depósito elegido no existe.");
    }

    const { rows: actuales } = await client.query<{
      id: string; orden_item_id: string | null; producto_id: string | null; producto_nombre: string | null;
      cantidad: string; costo: string; facturada: string;
    }>(
      `SELECT id, orden_item_id, producto_id, producto_nombre, cantidad_recibida::text AS cantidad,
              costo_unitario_recibido::text AS costo, COALESCE(cantidad_facturada, 0)::text AS facturada
         FROM ${tRI} WHERE recepcion_id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [id, empresaId]
    );

    // Nuevos valores por línea (las que no vienen quedan igual).
    const nuevos = new Map(actuales.map((a) => [a.id, { cantidad: Number(a.cantidad), costo: Number(a.costo) }]));
    for (const it of d.items ?? []) {
      const a = actuales.find((x) => x.id === it.id);
      if (!a) throw new RecepcionError("Algún ítem no pertenece a esta recepción.");
      const cantidad = Number(it.cantidad_recibida);
      const costo = Number(it.costo_unitario_recibido);
      const nombre = a.producto_nombre ?? "Ítem";
      if (!(cantidad > 0)) throw new RecepcionError(`"${nombre}": la cantidad tiene que ser mayor a 0. Para sacar todo, anulá la recepción.`);
      if (!(costo >= 0)) throw new RecepcionError(`"${nombre}": el costo no puede ser negativo.`);
      if (cantidad + 1e-9 < Number(a.facturada)) {
        throw new RecepcionError(`"${nombre}": ya se facturaron ${Number(a.facturada)}; la cantidad no puede quedar por debajo.`);
      }
      nuevos.set(a.id, { cantidad, costo });
    }

    // No recibir más de lo pedido (salvo recepción ya marcada como excedente).
    if (!r.excedente_confirmado) {
      for (const a of actuales) {
        const nv = nuevos.get(a.id)!;
        if (!a.orden_item_id || nv.cantidad <= Number(a.cantidad)) continue;
        const { rows: q } = await client.query<{ pedido: string; otras: string }>(
          `SELECT oi.cantidad::text AS pedido,
                  COALESCE((SELECT SUM(ri.cantidad_recibida) FROM ${tRI} ri JOIN ${tR} r2 ON r2.id = ri.recepcion_id
                             WHERE ri.orden_item_id = oi.id AND r2.estado = 'confirmada' AND ri.recepcion_id <> $2::uuid), 0)::text AS otras
             FROM ${tOCI} oi WHERE oi.id = $1::uuid`,
          [a.orden_item_id, id]
        );
        const max = Number(q[0]?.pedido ?? 0) - Number(q[0]?.otras ?? 0);
        if (nv.cantidad > max + 1e-9) {
          throw new RecepcionError(
            `"${a.producto_nombre ?? "Ítem"}": la orden pide ${Number(q[0]?.pedido ?? 0)}${Number(q[0]?.otras ?? 0) > 0 ? ` y otras recepciones ya trajeron ${Number(q[0]?.otras)}` : ""}, así que acá puede quedar como máximo ${Math.max(0, max)}. Para recibir de más, registrá una recepción excedente.`
          );
        }
      }
    }

    // Stock por producto: lo que había entrado vs. lo que queda.
    const porProducto = new Map<string, { nombre: string; antes: number; despues: number; costoAntes: number; costoDespues: number }>();
    for (const a of actuales) {
      if (!a.producto_id) continue;
      const nv = nuevos.get(a.id)!;
      const p = porProducto.get(a.producto_id) ?? { nombre: a.producto_nombre ?? "", antes: 0, despues: 0, costoAntes: 0, costoDespues: 0 };
      p.antes += Number(a.cantidad);
      p.despues += nv.cantidad;
      p.costoAntes += Number(a.cantidad) * Number(a.costo);
      p.costoDespues += nv.cantidad * nv.costo;
      porProducto.set(a.producto_id, p);
    }
    const mismoDeposito = (r.ubicacion_id ?? null) === (ubicNueva ?? null);
    const referencia = `Corrección ${r.numero}`;

    for (const [productoId, p] of porProducto) {
      const delta = p.despues - p.antes;
      const { rows: st } = await client.query<{ total: string; dep: string | null }>(
        `SELECT p.stock_actual::text AS total,
                (SELECT s.stock_actual::text FROM ${tSU} s
                  WHERE s.producto_id = p.id AND s.ubicacion_id = $3::uuid AND s.empresa_id = p.empresa_id) AS dep
           FROM ${tP} p WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid FOR UPDATE`,
        [productoId, empresaId, r.ubicacion_id]
      );
      // Cuánto hay que sacar del lugar donde entró.
      // Si no tenía depósito, el cambio de depósito no saca nada del total.
      const sacar = mismoDeposito || !r.ubicacion_id ? Math.max(0, -delta) : p.antes;
      const hay = r.ubicacion_id ? Number(st[0]?.dep ?? 0) : Number(st[0]?.total ?? 0);
      if (sacar > 0 && hay + 1e-9 < sacar) {
        throw new RecepcionError(
          `"${p.nombre}": hay que sacar ${sacar} del depósito y quedan ${hay}. Ya se usó o vendió parte; no se puede hacer este cambio.`,
          409
        );
      }

      const costoNuevo = p.despues > 0 ? p.costoDespues / p.despues : 0;
      if (Math.abs(delta) > 1e-9) {
        await client.query(
          `INSERT INTO ${tM} (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
             costo_unitario, origen, referencia, fecha, created_by, usuario_nombre, documento_tipo, documento_id)
           SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''), $4, $5::numeric, $6::numeric,
                  'recepcion', $7, clock_timestamp(), $8::uuid, $9, 'recepcion', $10::uuid
             FROM ${tP} p WHERE p.id = $2::uuid AND p.empresa_id = $1::uuid`,
          [empresaId, productoId, p.nombre, delta > 0 ? "ENTRADA" : "SALIDA", Math.abs(delta), costoNuevo,
           referencia, usuario.id, usuario.nombre, id]
        );
        await client.query(
          `UPDATE ${tP} SET stock_actual = COALESCE(stock_actual, 0) + $1::numeric, updated_at = now()
            WHERE id = $2::uuid AND empresa_id = $3::uuid`,
          [delta, productoId, empresaId]
        );
      }

      // Por depósito: mismo depósito → solo la diferencia; otro → sale todo de uno y entra al otro.
      const mover = async (ubic: string, cantidad: number) => {
        if (Math.abs(cantidad) < 1e-9) return;
        await client.query(
          `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric)
           ON CONFLICT (empresa_id, producto_id, ubicacion_id)
             DO UPDATE SET stock_actual = ${tSU.split(".").pop()}.stock_actual + EXCLUDED.stock_actual, updated_at = now()`,
          [empresaId, productoId, ubic, cantidad]
        );
      };
      if (mismoDeposito) {
        if (r.ubicacion_id) await mover(r.ubicacion_id, delta);
      } else {
        if (r.ubicacion_id) await mover(r.ubicacion_id, -p.antes);
        if (ubicNueva) await mover(ubicNueva, p.despues);
      }

      // Costo promedio: solo si cambió y nadie más trajo ese producto después.
      const costoAntes = p.antes > 0 ? p.costoAntes / p.antes : 0;
      if (Math.abs(costoNuevo - costoAntes) > 1e-6) {
        const { rows: despues } = await client.query(
          `SELECT 1 FROM ${tM}
            WHERE empresa_id = $1::uuid AND producto_id = $2::uuid AND tipo = 'ENTRADA' AND fecha > $3::timestamptz
              AND origen IN ('recepcion', 'compra', 'carga_proveedor')
              AND NOT (documento_tipo = 'recepcion' AND documento_id = $4::uuid)
            LIMIT 1`,
          [empresaId, productoId, r.created_at, id]
        );
        if (!despues[0]) {
          await client.query(`UPDATE ${tP} SET costo_promedio = $1::numeric WHERE id = $2::uuid AND empresa_id = $3::uuid`, [
            costoNuevo,
            productoId,
            empresaId,
          ]);
        }
      }
    }

    for (const a of actuales) {
      const nv = nuevos.get(a.id)!;
      if (nv.cantidad === Number(a.cantidad) && nv.costo === Number(a.costo)) continue;
      await client.query(
        `UPDATE ${tRI} SET cantidad_recibida = $3::numeric, costo_unitario_recibido = $4::numeric
          WHERE id = $1::uuid AND empresa_id = $2::uuid`,
        [a.id, empresaId, nv.cantidad, nv.costo]
      );
    }

    await client.query(
      `UPDATE ${tR}
          SET fecha = COALESCE($3::date, fecha),
              observacion = CASE WHEN $4::boolean THEN $5 ELSE observacion END,
              documento_url = CASE WHEN $6::boolean THEN $7 ELSE documento_url END,
              ubicacion_id = $8::uuid,
              updated_at = now()
        WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [id, empresaId, fecha, obs !== undefined, obs ?? null, doc !== undefined, doc ?? null, ubicNueva]
    );
    await recalcularFacturacionRecepcionEnTx(client, schema, empresaId, id);
    await recalcularEstadoOrdenEnTx(client, schema, empresaId, r.orden_id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}
