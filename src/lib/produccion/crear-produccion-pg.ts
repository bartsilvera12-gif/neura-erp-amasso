import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { convertirCantidad } from "@/lib/unidades/convert";

/**
 * Fabricar desde una receta: descuenta materia prima, sube el terminado y deja
 * el kardex.
 *
 * Portado del ERP de La Mexicana (`neura-erp-mexicana`), que es donde nació el
 * recetario, pero reescrito en dos puntos porque el modelo de inventario de este
 * ERP es distinto:
 *
 *  1. **Stock en dos lugares, no en uno.** La Mexicana asienta solo
 *     `productos.stock_actual`. Acá cada movimiento escribe además
 *     `inventario_stock_ubicacion`, que es de donde los repartos leen el saldo
 *     real de cada camión y del depósito (ver `lib/repartos/server/repartos-pg.ts`).
 *     Si la fabricación tocara solo el total global, Inventario → Depósitos y
 *     Stock por camión quedarían mintiendo.
 *
 *  2. **Una transacción de verdad.** La Mexicana usa PostgREST, que no las
 *     expone, y compensa con un rollback "best effort" que borra lo insertado si
 *     algo falla a mitad de camino — si ese borrado también falla, queda una
 *     producción a medias. Acá se usa el pool de Postgres con BEGIN/COMMIT, igual
 *     que las recepciones de compra (`lib/recepciones/server/recepciones-pg.ts`),
 *     así que o entra todo o no entra nada.
 *
 * Sobre la disponibilidad: se valida contra `productos.stock_actual`, que es el
 * total de la empresa y el número que gobierna en todo el ERP. El saldo por
 * ubicación es el desglose: al consumir se le resta con piso en 0, así que si la
 * materia prima se recibió en otra ubicación que no es el obrador, el desglose
 * del obrador queda en 0 y el total sigue siendo el que manda.
 */

/** Un faltante de materia prima detectado al validar la fabricación. */
export interface FaltanteInsumoProduccion {
  producto_id: string;
  nombre: string;
  sku: string;
  unidad: string | null;
  stock_actual: number;
  requerido: number;
  faltante: number;
}

/**
 * Se lanza cuando falta materia prima y NO se autorizó fabricar sin stock
 * (`permitirSinStock` ausente/false). Lleva el detalle para que la UI muestre
 * el modal de confirmación y reintente con el flag.
 */
export class InsumoInsuficienteError extends Error {
  faltantes: FaltanteInsumoProduccion[];
  constructor(faltantes: FaltanteInsumoProduccion[]) {
    super("Materia prima insuficiente para la fabricación solicitada.");
    this.name = "InsumoInsuficienteError";
    this.faltantes = faltantes;
  }
}

/** Error con status listo para la respuesta HTTP. */
export class ProduccionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProduccionError";
    this.status = status;
  }
}

export interface CrearProduccionParams {
  schema: string;
  empresaId: string;
  recetaId: string;
  cantidadFabricar: number;
  /**
   * Ubicación donde se fabrica: de ahí sale la materia prima y ahí entra el
   * terminado. Si no se pasa y hay una sola ubicación que no es camión, se usa
   * esa. Un camión nunca es válido: no se amasa arriba de un camión.
   */
  ubicacionId?: string | null;
  observaciones?: string | null;
  /** Si true, autoriza fabricar aunque falte materia prima (el stock de insumo puede quedar en 0). */
  permitirSinStock?: boolean;
  usuarioId?: string | null;
  usuarioNombre?: string | null;
}

/** Un insumo requerido por la fabricación, ya convertido a la unidad del insumo. */
export interface InsumoRequerido {
  producto_id: string;
  nombre: string;
  sku: string;
  unidad: string | null;
  requerido: number;
  stock_actual: number;
  costo_unitario: number;
  subcosto: number;
  faltante: number;
}

export interface ProduccionPreview {
  receta_id: string;
  producto_id: string;
  producto_nombre: string;
  cantidad_fabricar: number;
  rendimiento_cantidad: number;
  unidad_rendimiento: string | null;
  ubicacion_id: string;
  ubicacion_nombre: string;
  insumos: InsumoRequerido[];
  insumos_incompatibles: string[];
  costo_total: number;
  costo_unitario: number;
  hay_faltantes: boolean;
}

export interface CrearProduccionResult {
  produccion_id: string;
  producto_id: string;
  producto_nombre: string;
  cantidad_fabricada: number;
  costo_total: number;
  costo_unitario: number;
  costo_promedio_nuevo: number;
  stock_terminado_nuevo: number;
  ubicacion_id: string;
  ubicacion_nombre: string;
  insumos: InsumoRequerido[];
}

type PgClient = {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: R[] }>;
  release: () => void;
};

type RecetaInfo = {
  recetaId: string;
  productoId: string;
  productoNombre: string;
  productoSku: string;
  productoStock: number;
  productoCosto: number;
  rendimiento: number;
  unidadRendimiento: string | null;
};

type InsumoMeta = { stock: number; costo: number; nombre: string; sku: string; unidad: string | null };

type Plan = {
  receta: RecetaInfo;
  insumoMeta: Map<string, InsumoMeta>;
  insumoNeed: Map<string, number>;
  insumosIncompatibles: string[];
  ubicacionId: string;
  ubicacionNombre: string;
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

function pool() {
  const p = getChatPostgresPool();
  if (!p) {
    throw new ProduccionError(
      "No hay conexión directa a Postgres configurada (SUPABASE_DB_URL).",
      500
    );
  }
  return p;
}

/**
 * Resuelve dónde se fabrica. Explícita si vino en el pedido; si no, la única
 * ubicación activa que no sea camión. Con varias candidatas no adivina: pide
 * que se elija, porque descontar del lugar equivocado no se nota hasta el
 * inventario físico.
 */
async function resolverUbicacion(
  client: PgClient,
  schema: string,
  empresaId: string,
  pedida: string | null | undefined
): Promise<{ id: string; nombre: string }> {
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");

  if (pedida) {
    const q = await client.query<{ id: string; nombre: string; tipo: string; activo: boolean }>(
      `SELECT id, nombre, tipo, activo FROM ${tU}
        WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [pedida, empresaId]
    );
    const u = q.rows[0];
    if (!u) throw new ProduccionError("La ubicación indicada no existe en esta empresa.", 404);
    if (!u.activo) throw new ProduccionError(`La ubicación "${u.nombre}" está inactiva.`);
    if (u.tipo === "camion") {
      throw new ProduccionError(
        `"${u.nombre}" es un camión. La fabricación tiene que salir de un depósito, no de un camión.`
      );
    }
    return { id: u.id, nombre: u.nombre };
  }

  const q = await client.query<{ id: string; nombre: string }>(
    `SELECT id, nombre FROM ${tU}
      WHERE empresa_id = $1::uuid AND activo = true AND tipo <> 'camion'
      ORDER BY nombre`,
    [empresaId]
  );
  if (q.rows.length === 0) {
    throw new ProduccionError(
      "No hay ninguna ubicación de depósito cargada. Creá una en Inventario → Depósitos / Ubicaciones antes de fabricar."
    );
  }
  if (q.rows.length > 1) {
    throw new ProduccionError(
      `Hay ${q.rows.length} depósitos: elegí en cuál se fabrica (${q.rows
        .map((u) => u.nombre)
        .join(", ")}).`
    );
  }
  return { id: q.rows[0].id, nombre: q.rows[0].nombre };
}

/**
 * Carga receta + terminado + ítems + insumos y calcula el requerimiento de
 * materia prima para fabricar `cantidadFabricar`.
 *
 * `lock` bloquea las filas de `productos` involucradas (terminado + insumos) en
 * un solo SELECT ... FOR UPDATE ordenado por id: así dos fabricaciones
 * simultáneas no se pisan el stock, y el orden fijo evita deadlocks entre ellas.
 */
async function cargarPlan(
  client: PgClient,
  params: CrearProduccionParams,
  opts: { lock: boolean }
): Promise<Plan> {
  const schema = assertAllowedChatDataSchema(params.schema);
  const cantidad = num(params.cantidadFabricar);
  if (!(cantidad > 0)) throw new ProduccionError("La cantidad a fabricar debe ser mayor a cero.");

  const tR = quoteSchemaTable(schema, "recetas");
  const tRI = quoteSchemaTable(schema, "receta_items");
  const tP = quoteSchemaTable(schema, "productos");

  const ubicacion = await resolverUbicacion(client, schema, params.empresaId, params.ubicacionId);

  // 1) Receta.
  const recQ = await client.query<{
    id: string;
    producto_id: string;
    rendimiento_cantidad: string | number | null;
    rendimiento_unidad: string | null;
    activa: boolean | null;
  }>(
    `SELECT id, producto_id, rendimiento_cantidad, rendimiento_unidad, activa
       FROM ${tR} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [params.recetaId, params.empresaId]
  );
  const rec = recQ.rows[0];
  if (!rec) throw new ProduccionError("Receta no encontrada en esta empresa.", 404);
  if (rec.activa === false) {
    throw new ProduccionError("La receta está inactiva; activala antes de fabricar.");
  }

  // 2) Ítems de la receta.
  const itemsQ = await client.query<{
    insumo_producto_id: string;
    cantidad: string | number;
    unidad_medida: string | null;
    merma_pct: string | number | null;
  }>(
    `SELECT insumo_producto_id, cantidad, unidad_medida, merma_pct
       FROM ${tRI} WHERE receta_id = $1::uuid ORDER BY orden`,
    [rec.id]
  );
  if (itemsQ.rows.length === 0) {
    throw new ProduccionError("La receta no tiene insumos cargados; no se puede fabricar.");
  }

  // 3) Productos involucrados: terminado + insumos, en un solo lock ordenado.
  const insumoIds = [...new Set(itemsQ.rows.map((it) => it.insumo_producto_id))];
  const todosIds = [...new Set([rec.producto_id, ...insumoIds])];
  const prodQ = await client.query<{
    id: string;
    nombre: string;
    sku: string | null;
    stock_actual: string | number | null;
    costo_promedio: string | number | null;
    unidad_medida: string | null;
  }>(
    `SELECT id, nombre, sku, stock_actual, costo_promedio, unidad_medida
       FROM ${tP}
      WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])
      ORDER BY id
      ${opts.lock ? "FOR UPDATE" : ""}`,
    [params.empresaId, todosIds]
  );
  const porId = new Map(prodQ.rows.map((p) => [p.id, p]));

  const term = porId.get(rec.producto_id);
  if (!term) throw new ProduccionError("El producto terminado de la receta no existe.", 404);

  const faltanInsumos = insumoIds.filter((i) => !porId.has(i));
  if (faltanInsumos.length > 0) {
    throw new ProduccionError(
      `La receta referencia insumos inexistentes en esta empresa: ${faltanInsumos.join(", ")}`
    );
  }

  const rendimiento = num(rec.rendimiento_cantidad);
  const receta: RecetaInfo = {
    recetaId: rec.id,
    productoId: term.id,
    productoNombre: term.nombre,
    productoSku: term.sku ?? "",
    productoStock: num(term.stock_actual),
    productoCosto: num(term.costo_promedio),
    rendimiento: rendimiento > 0 ? rendimiento : 1,
    unidadRendimiento: rec.rendimiento_unidad ?? null,
  };

  const insumoMeta = new Map<string, InsumoMeta>();
  for (const id of insumoIds) {
    const p = porId.get(id)!;
    insumoMeta.set(id, {
      stock: num(p.stock_actual),
      costo: num(p.costo_promedio),
      nombre: p.nombre,
      sku: p.sku ?? "",
      unidad: p.unidad_medida ?? null,
    });
  }

  // 4) Requerimiento por insumo, convertido a la unidad del insumo:
  //    consumo = cantidadFabricar * cantidad_item_conv * (1 + merma) / rendimiento
  const insumoNeed = new Map<string, number>();
  const insumosIncompatibles: string[] = [];
  for (const it of itemsQ.rows) {
    const meta = insumoMeta.get(it.insumo_producto_id)!;
    const unidadItem = it.unidad_medida ?? null;
    const unidadInsumo = meta.unidad;
    const cantBase = num(it.cantidad);
    const merma = num(it.merma_pct);
    const cantConv =
      unidadItem == null || unidadInsumo == null
        ? cantBase
        : convertirCantidad(cantBase, unidadItem, unidadInsumo);
    if (cantConv == null) {
      if (!insumosIncompatibles.includes(meta.nombre)) insumosIncompatibles.push(meta.nombre);
      continue;
    }
    const consumo = (cantidad * cantConv * (1 + merma)) / receta.rendimiento;
    if (!(consumo > 0)) continue;
    insumoNeed.set(it.insumo_producto_id, (insumoNeed.get(it.insumo_producto_id) ?? 0) + consumo);
  }
  for (const [k, v] of insumoNeed) insumoNeed.set(k, r6(v));

  return {
    receta,
    insumoMeta,
    insumoNeed,
    insumosIncompatibles,
    ubicacionId: ubicacion.id,
    ubicacionNombre: ubicacion.nombre,
  };
}

/** Detalle de insumos + costo total a partir del plan. */
function detallar(plan: Plan): { insumos: InsumoRequerido[]; costoTotal: number } {
  const insumos: InsumoRequerido[] = [];
  let costoTotal = 0;
  for (const [insId, need] of plan.insumoNeed) {
    const m = plan.insumoMeta.get(insId)!;
    const subcosto = r6(need * m.costo);
    costoTotal += subcosto;
    insumos.push({
      producto_id: insId,
      nombre: m.nombre,
      sku: m.sku,
      unidad: m.unidad,
      requerido: need,
      stock_actual: m.stock,
      costo_unitario: m.costo,
      subcosto,
      faltante: m.stock < need ? r6(need - m.stock) : 0,
    });
  }
  return { insumos, costoTotal: r6(costoTotal) };
}

/** Solo el cálculo, sin escribir nada: requeridos / faltantes / costo para la UI. */
export async function previewProduccion(
  params: CrearProduccionParams
): Promise<ProduccionPreview> {
  const client = (await pool().connect()) as unknown as PgClient;
  try {
    const plan = await cargarPlan(client, params, { lock: false });
    const cantidad = num(params.cantidadFabricar);
    const { insumos, costoTotal } = detallar(plan);
    return {
      receta_id: plan.receta.recetaId,
      producto_id: plan.receta.productoId,
      producto_nombre: plan.receta.productoNombre,
      cantidad_fabricar: cantidad,
      rendimiento_cantidad: plan.receta.rendimiento,
      unidad_rendimiento: plan.receta.unidadRendimiento,
      ubicacion_id: plan.ubicacionId,
      ubicacion_nombre: plan.ubicacionNombre,
      insumos,
      insumos_incompatibles: plan.insumosIncompatibles,
      costo_total: costoTotal,
      costo_unitario: cantidad > 0 ? r6(costoTotal / cantidad) : 0,
      hay_faltantes: insumos.some((i) => i.faltante > 0),
    };
  } finally {
    client.release();
  }
}

/**
 * Registra una fabricación, todo en una transacción:
 *   · descuenta cada insumo del total y del saldo de la ubicación, con SALIDA
 *     origen 'produccion' en el kardex
 *   · sube el terminado en el total y en la ubicación, con ENTRADA
 *   · recalcula el costo_promedio del terminado por promedio ponderado
 *   · guarda producciones + produccion_items para trazabilidad
 */
export async function crearProduccionPg(
  params: CrearProduccionParams
): Promise<CrearProduccionResult> {
  const schema = assertAllowedChatDataSchema(params.schema);
  const tProducciones = quoteSchemaTable(schema, "producciones");
  const tItems = quoteSchemaTable(schema, "produccion_items");
  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  // En ON CONFLICT DO UPDATE la tabla destino se referencia por su nombre, no
  // calificado con el schema.
  const suBare = tSU.split(".").pop()!;

  const client = (await pool().connect()) as unknown as PgClient;
  let abierta = false;
  try {
    await client.query("BEGIN");
    abierta = true;

    const plan = await cargarPlan(client, params, { lock: true });
    const cantidad = num(params.cantidadFabricar);
    const { insumos: insumosDetalle, costoTotal } = detallar(plan);
    const costoUnitario = cantidad > 0 ? r6(costoTotal / cantidad) : 0;

    if (plan.insumosIncompatibles.length > 0) {
      console.warn(
        "[crear-produccion-pg] receta con unidades incompatibles (no se descuentan):",
        plan.insumosIncompatibles.join(", ")
      );
    }

    // Disponibilidad: contra el total de la empresa (ver nota de cabecera).
    const faltantes: FaltanteInsumoProduccion[] = insumosDetalle
      .filter((i) => i.faltante > 0)
      .map((i) => ({
        producto_id: i.producto_id,
        nombre: i.nombre,
        sku: i.sku,
        unidad: i.unidad,
        stock_actual: i.stock_actual,
        requerido: i.requerido,
        faltante: i.faltante,
      }));
    if (faltantes.length > 0 && !params.permitirSinStock) {
      throw new InsumoInsuficienteError(faltantes);
    }

    const fechaIso = new Date().toISOString();

    // Auditoría: si se fabricó con materia prima insuficiente, dejar constancia.
    let observacionesFinal = params.observaciones ?? null;
    if (faltantes.length > 0 && params.permitirSinStock) {
      const detalle = faltantes
        .map((f) => `${f.nombre} (stock ${f.stock_actual}, requerido ${f.requerido}, falta ${f.faltante})`)
        .join("; ");
      const nota = `Fabricación con materia prima insuficiente autorizada: ${detalle}`;
      observacionesFinal = (observacionesFinal ? `${observacionesFinal} | ${nota}` : nota).slice(0, 4000);
    }

    // 1) Cabecera.
    const insProd = await client.query<{ id: string }>(
      `INSERT INTO ${tProducciones} (
         empresa_id, receta_id, producto_id, producto_nombre, cantidad_fabricada,
         rendimiento_cantidad, unidad_rendimiento, costo_total, costo_unitario,
         fecha, usuario_id, usuario_nombre, observaciones
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric,
                 $6::numeric, $7, $8::numeric, $9::numeric,
                 $10::timestamptz, $11::uuid, $12, $13)
       RETURNING id`,
      [
        params.empresaId,
        plan.receta.recetaId,
        plan.receta.productoId,
        plan.receta.productoNombre,
        cantidad,
        plan.receta.rendimiento,
        plan.receta.unidadRendimiento,
        costoTotal,
        costoUnitario,
        fechaIso,
        params.usuarioId ?? null,
        params.usuarioNombre ?? null,
        observacionesFinal,
      ]
    );
    const produccionId = insProd.rows[0].id;

    // 2) Renglones.
    for (const d of insumosDetalle) {
      await client.query(
        `INSERT INTO ${tItems} (
           empresa_id, produccion_id, insumo_producto_id, insumo_nombre,
           cantidad, unidad_medida, costo_unitario, subcosto
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6, $7::numeric, $8::numeric)`,
        [
          params.empresaId,
          produccionId,
          d.producto_id,
          d.nombre,
          d.requerido,
          d.unidad,
          d.costo_unitario,
          d.subcosto,
        ]
      );
    }

    // 3) Consumo de materia prima: total + saldo de la ubicación + kardex.
    for (const d of insumosDetalle) {
      await client.query(
        `UPDATE ${tP}
            SET stock_actual = GREATEST(0, COALESCE(stock_actual, 0) - $1::numeric),
                updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [d.requerido, d.producto_id, params.empresaId]
      );

      // Piso en 0: si la materia prima se recibió en otra ubicación, el desglose
      // de esta no puede quedar negativo (el total global es el que gobierna).
      await client.query(
        `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 0)
         ON CONFLICT (empresa_id, producto_id, ubicacion_id)
         DO UPDATE SET stock_actual = GREATEST(0, ${suBare}.stock_actual - $4::numeric),
                       updated_at = now()`,
        [params.empresaId, d.producto_id, plan.ubicacionId, d.requerido]
      );

      await client.query(
        `INSERT INTO ${tM} (
           empresa_id, producto_id, producto_nombre, producto_sku,
           tipo, cantidad, costo_unitario, origen, referencia, fecha,
           ubicacion_id, produccion_id, created_by, usuario_nombre
         ) VALUES ($1::uuid, $2::uuid, $3, $4, 'SALIDA', $5::numeric, $6::numeric,
                   'produccion', $7, $8::timestamptz, $9::uuid, $10::uuid, $11::uuid, $12)`,
        [
          params.empresaId,
          d.producto_id,
          d.nombre,
          d.sku,
          d.requerido,
          d.costo_unitario,
          `Producción de ${plan.receta.productoNombre}`,
          fechaIso,
          plan.ubicacionId,
          produccionId,
          params.usuarioId ?? null,
          params.usuarioNombre ?? null,
        ]
      );
    }

    // 4) Terminado: total + costo promedio ponderado + saldo de la ubicación + kardex.
    //    nuevoCosto = (stockAnt*costoAnt + costoTotal) / (stockAnt + cantidad)
    const stockAnt = plan.receta.productoStock;
    const stockNuevo = r6(stockAnt + cantidad);
    const costoPromNuevo = r6(
      stockNuevo > 0
        ? (stockAnt * plan.receta.productoCosto + costoTotal) / stockNuevo
        : costoUnitario
    );

    await client.query(
      `UPDATE ${tP} SET stock_actual = $1::numeric, costo_promedio = $2::numeric, updated_at = now()
        WHERE id = $3::uuid AND empresa_id = $4::uuid`,
      [stockNuevo, costoPromNuevo, plan.receta.productoId, params.empresaId]
    );

    await client.query(
      `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric)
       ON CONFLICT (empresa_id, producto_id, ubicacion_id)
       DO UPDATE SET stock_actual = ${suBare}.stock_actual + EXCLUDED.stock_actual,
                     updated_at = now()`,
      [params.empresaId, plan.receta.productoId, plan.ubicacionId, cantidad]
    );

    await client.query(
      `INSERT INTO ${tM} (
         empresa_id, producto_id, producto_nombre, producto_sku,
         tipo, cantidad, costo_unitario, origen, referencia, fecha,
         ubicacion_id, produccion_id, created_by, usuario_nombre
       ) VALUES ($1::uuid, $2::uuid, $3, $4, 'ENTRADA', $5::numeric, $6::numeric,
                 'produccion', $7, $8::timestamptz, $9::uuid, $10::uuid, $11::uuid, $12)`,
      [
        params.empresaId,
        plan.receta.productoId,
        plan.receta.productoNombre,
        plan.receta.productoSku,
        cantidad,
        costoUnitario,
        `Fabricación en ${plan.ubicacionNombre}`,
        fechaIso,
        plan.ubicacionId,
        produccionId,
        params.usuarioId ?? null,
        params.usuarioNombre ?? null,
      ]
    );

    await client.query("COMMIT");
    abierta = false;

    return {
      produccion_id: produccionId,
      producto_id: plan.receta.productoId,
      producto_nombre: plan.receta.productoNombre,
      cantidad_fabricada: cantidad,
      costo_total: costoTotal,
      costo_unitario: costoUnitario,
      costo_promedio_nuevo: costoPromNuevo,
      stock_terminado_nuevo: stockNuevo,
      ubicacion_id: plan.ubicacionId,
      ubicacion_nombre: plan.ubicacionNombre,
      insumos: insumosDetalle,
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
