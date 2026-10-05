import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Alta de un movimiento de inventario, del lado del servidor y en una transacción.
 *
 * Antes esto vivía en el navegador (`lib/inventario/storage.ts`, `saveMovimiento`)
 * y tenía dos problemas que QA encontró el mismo día:
 *
 *  1. **Asentaba el stock en un solo lugar.** Actualizaba `productos.stock_actual`
 *     y nunca `inventario_stock_ubicacion`, que es de donde Depósitos y los
 *     repartos leen el saldo real. Por eso la pantalla de Depósitos no mostraba
 *     nada: los movimientos jamás escribían esa tabla.
 *
 *  2. **No era atómico.** Leía el stock, insertaba el movimiento y después
 *     actualizaba el producto, en tres viajes sueltos desde el navegador. Dos
 *     envíos seguidos —un doble clic, o el mismo clic contado dos veces—
 *     entraban los dos y el stock sumaba el doble.
 *
 * Acá es una sola transacción con la fila del producto bloqueada (`FOR UPDATE`),
 * igual que las recepciones de compra y la fabricación de recetas.
 */

export class MovimientoError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MovimientoError";
    this.status = status;
  }
}

export type TipoMovimientoServidor = "ENTRADA" | "SALIDA" | "AJUSTE";

/** Los que acepta el CHECK de `movimientos_inventario.origen` para un alta manual. */
const ORIGENES_MANUALES = new Set([
  "compra",
  "venta",
  "ajuste_manual",
  "inventario_inicial",
]);

export interface CrearMovimientoParams {
  schema: string;
  empresaId: string;
  productoId: string;
  tipo: TipoMovimientoServidor;
  /** ENTRADA/SALIDA: siempre positiva. AJUSTE: lleva signo. */
  cantidad: number;
  costoUnitario: number;
  origen: string;
  referencia?: string | null;
  /** De dónde sale o a dónde entra. Si no viene, el único depósito que no sea camión. */
  ubicacionId?: string | null;
  usuarioId?: string | null;
  usuarioNombre?: string | null;
}

export interface CrearMovimientoResult {
  movimiento_id: string;
  producto_id: string;
  producto_nombre: string;
  stock_anterior: number;
  stock_nuevo: number;
  ubicacion_id: string;
  ubicacion_nombre: string;
  saldo_ubicacion_nuevo: number;
}

type PgClient = {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: R[] }>;
  release: () => void;
};

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Redondeo a 6 decimales: evita el ruido de coma flotante al acumular. */
function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function delta(tipo: TipoMovimientoServidor, cantidad: number): number {
  if (tipo === "ENTRADA") return Math.abs(cantidad);
  if (tipo === "SALIDA") return -Math.abs(cantidad);
  return cantidad; // AJUSTE: la cantidad ya lleva el signo
}

/**
 * Resuelve la ubicación. Explícita si vino; si no, la única activa que no sea
 * camión. Con varias no adivina: descontar del lugar equivocado no se nota
 * hasta el inventario físico.
 */
async function resolverUbicacion(
  client: PgClient,
  schema: string,
  empresaId: string,
  pedida: string | null | undefined
): Promise<{ id: string; nombre: string }> {
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");

  if (pedida) {
    const q = await client.query<{ id: string; nombre: string; activo: boolean }>(
      `SELECT id, nombre, activo FROM ${tU} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [pedida, empresaId]
    );
    const u = q.rows[0];
    if (!u) throw new MovimientoError("La ubicación indicada no existe en esta empresa.", 404);
    if (!u.activo) throw new MovimientoError(`La ubicación "${u.nombre}" está inactiva.`);
    return { id: u.id, nombre: u.nombre };
  }

  const q = await client.query<{ id: string; nombre: string }>(
    `SELECT id, nombre FROM ${tU}
      WHERE empresa_id = $1::uuid AND activo = true AND tipo <> 'camion'
      ORDER BY nombre`,
    [empresaId]
  );
  if (q.rows.length === 0) {
    throw new MovimientoError(
      "No hay ninguna ubicación cargada. Creá un depósito en Inventario → Depósitos / Ubicaciones."
    );
  }
  if (q.rows.length > 1) {
    throw new MovimientoError(
      `Hay ${q.rows.length} depósitos: elegí en cuál se registra el movimiento (${q.rows
        .map((u) => u.nombre)
        .join(", ")}).`
    );
  }
  return { id: q.rows[0].id, nombre: q.rows[0].nombre };
}

export async function crearMovimientoPg(
  params: CrearMovimientoParams
): Promise<CrearMovimientoResult> {
  const schema = assertAllowedChatDataSchema(params.schema);

  const cantidad = num(params.cantidad);
  if (params.tipo === "AJUSTE") {
    if (cantidad === 0) throw new MovimientoError("Un ajuste no puede ser de cero.");
  } else if (!(cantidad > 0)) {
    throw new MovimientoError("La cantidad debe ser mayor a cero.");
  }
  if (!ORIGENES_MANUALES.has(params.origen)) {
    throw new MovimientoError(`Origen no válido para un alta manual: ${params.origen}`);
  }

  const pool = getChatPostgresPool();
  if (!pool) throw new MovimientoError("No hay conexión directa a Postgres.", 500);

  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  // En ON CONFLICT DO UPDATE la tabla destino se nombra sin calificar con el schema.
  const suBare = tSU.split(".").pop()!;

  const client = (await pool.connect()) as unknown as PgClient;
  let abierta = false;
  try {
    await client.query("BEGIN");
    abierta = true;

    const ubicacion = await resolverUbicacion(client, schema, params.empresaId, params.ubicacionId);

    // La fila queda bloqueada hasta el COMMIT: dos altas simultáneas del mismo
    // producto se serializan en vez de pisarse el stock.
    const prodQ = await client.query<{
      id: string;
      nombre: string;
      sku: string | null;
      stock_actual: string | number | null;
    }>(
      `SELECT id, nombre, sku, stock_actual FROM ${tP}
        WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [params.productoId, params.empresaId]
    );
    const prod = prodQ.rows[0];
    if (!prod) throw new MovimientoError("El producto no existe en esta empresa.", 404);

    const stockAnterior = num(prod.stock_actual);
    const d = delta(params.tipo, cantidad);
    const stockNuevo = r6(Math.max(0, stockAnterior + d));

    await client.query(
      `UPDATE ${tP} SET stock_actual = $1::numeric, updated_at = now()
        WHERE id = $2::uuid AND empresa_id = $3::uuid`,
      [stockNuevo, prod.id, params.empresaId]
    );

    // Saldo por ubicación, con piso en 0: es el desglose del total, que es el
    // número que gobierna en el resto del ERP.
    const suQ = await client.query<{ stock_actual: string | number }>(
      `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
       VALUES ($1::uuid, $2::uuid, $3::uuid, GREATEST(0, $4::numeric))
       ON CONFLICT (empresa_id, producto_id, ubicacion_id)
       DO UPDATE SET stock_actual = GREATEST(0, ${suBare}.stock_actual + $4::numeric),
                     updated_at = now()
       RETURNING stock_actual`,
      [params.empresaId, prod.id, ubicacion.id, d]
    );

    const movQ = await client.query<{ id: string }>(
      `INSERT INTO ${tM} (
         empresa_id, producto_id, producto_nombre, producto_sku,
         tipo, cantidad, costo_unitario, origen, referencia, fecha,
         ubicacion_id, created_by, usuario_nombre
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7::numeric, $8, $9,
                 now(), $10::uuid, $11::uuid, $12)
       RETURNING id`,
      [
        params.empresaId,
        prod.id,
        prod.nombre,
        prod.sku ?? "",
        params.tipo,
        Math.abs(cantidad),
        num(params.costoUnitario),
        params.origen,
        params.referencia ?? null,
        ubicacion.id,
        params.usuarioId ?? null,
        params.usuarioNombre ?? null,
      ]
    );

    await client.query("COMMIT");
    abierta = false;

    return {
      movimiento_id: movQ.rows[0].id,
      producto_id: prod.id,
      producto_nombre: prod.nombre,
      stock_anterior: stockAnterior,
      stock_nuevo: stockNuevo,
      ubicacion_id: ubicacion.id,
      ubicacion_nombre: ubicacion.nombre,
      saldo_ubicacion_nuevo: num(suQ.rows[0]?.stock_actual),
    };
  } catch (err) {
    if (abierta) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* la conexión ya se cayó: el servidor aborta la transacción igual */
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface StockUbicacionResumen {
  ubicacion_id: string;
  productos: number;
  unidades: number;
}

/** Cuántos productos y cuántas unidades hay en cada ubicación. Para el listado de Depósitos. */
export async function resumenStockPorUbicacion(
  schemaRaw: string,
  empresaId: string
): Promise<StockUbicacionResumen[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const pool = getChatPostgresPool();
  if (!pool) throw new MovimientoError("No hay conexión directa a Postgres.", 500);
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  const { rows } = await pool.query(
    `SELECT ubicacion_id,
            count(*) FILTER (WHERE stock_actual <> 0)::int AS productos,
            COALESCE(SUM(stock_actual), 0)::float8        AS unidades
       FROM ${tSU}
      WHERE empresa_id = $1::uuid
      GROUP BY ubicacion_id`,
    [empresaId]
  );
  return rows as StockUbicacionResumen[];
}

export interface StockUbicacionDetalle {
  producto_id: string;
  producto_nombre: string;
  sku: string | null;
  unidad_medida: string | null;
  stock_actual: number;
}

/** Qué hay en una ubicación, producto por producto. */
export async function detalleStockDeUbicacion(
  schemaRaw: string,
  empresaId: string,
  ubicacionId: string
): Promise<StockUbicacionDetalle[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const pool = getChatPostgresPool();
  if (!pool) throw new MovimientoError("No hay conexión directa a Postgres.", 500);
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  const tP = quoteSchemaTable(schema, "productos");
  const { rows } = await pool.query(
    `SELECT s.producto_id, p.nombre AS producto_nombre, p.sku, p.unidad_medida,
            s.stock_actual::float8 AS stock_actual
       FROM ${tSU} s
       JOIN ${tP} p ON p.id = s.producto_id
      WHERE s.empresa_id = $1::uuid AND s.ubicacion_id = $2::uuid
      ORDER BY p.nombre`,
    [empresaId, ubicacionId]
  );
  return rows as StockUbicacionDetalle[];
}
