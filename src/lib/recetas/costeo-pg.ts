import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { convertirCantidad } from "@/lib/unidades/convert";

/**
 * Costo teórico de una formulación (requerimiento de Amasso: "el costo de cada
 * producto sale de su formulación").
 *
 *   costo unitario = Σ (cantidad × (1 + merma del ingrediente) × costo del ingrediente)
 *                    ÷ (rendimiento × (1 − merma esperada))
 *
 * El costo de cada ingrediente sale de una de dos bases, a elección:
 *   - `promedio`: el costo promedio ponderado del producto (lo que valúa el stock).
 *   - `ultima_compra`: el costo unitario de su última compra (responde a la
 *     pregunta del documento: refleja enseguida una suba de precio).
 *
 * Un ingrediente intermedio con formulación propia (rellenos, masas base,
 * galleta molida) no usa su costo de stock: se costea con SU formulación, y ese
 * costo se traslada al producto final. Se corta en 6 niveles y ante ciclos.
 */

export type BaseCosto = "promedio" | "ultima_compra";

export type CosteoItem = {
  producto_id: string;
  nombre: string;
  clase: string;
  cantidad: number;
  unidad: string | null;
  merma_pct: number;
  costo_unitario: number;
  /** De dónde salió el costo del ingrediente. */
  fuente: "promedio" | "ultima_compra" | "formulacion" | "sin_costo";
  subcosto: number;
};

export type CosteoFormulacion = {
  receta_id: string;
  producto_id: string;
  producto_nombre: string;
  base: BaseCosto;
  rendimiento: number;
  rendimiento_unidad: string | null;
  merma_esperada: number;
  costo_lote: number;
  costo_unitario: number;
  precio_venta: number;
  margen_pct: number | null;
  items: CosteoItem[];
  avisos: string[];
};

type Q = { query: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

export async function costeoFormulacion(
  schemaRaw: string,
  empresaId: string,
  recetaId: string,
  base: BaseCosto,
  /** Valores en pantalla sin guardar; solo para la formulación pedida, no para sus intermedios. */
  vistaPrevia: { rendimiento?: number; merma?: number } = {}
): Promise<CosteoFormulacion> {
  const pool = getChatPostgresPool();
  if (!pool) throw new Error("No hay conexión directa a Postgres.");
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = {
    R: quoteSchemaTable(schema, "recetas"),
    RI: quoteSchemaTable(schema, "receta_items"),
    P: quoteSchemaTable(schema, "productos"),
    M: quoteSchemaTable(schema, "movimientos_inventario"),
  };
  const ultimaCompra = new Map<string, number | null>();

  async function costoUltimaCompra(c: Q, productoId: string): Promise<number | null> {
    if (ultimaCompra.has(productoId)) return ultimaCompra.get(productoId)!;
    const q = await c.query(
      `SELECT costo_unitario FROM ${t.M}
        WHERE empresa_id = $1::uuid AND producto_id = $2::uuid AND origen = 'compra' AND tipo = 'ENTRADA'
          AND anulado_at IS NULL
        ORDER BY fecha DESC LIMIT 1`,
      [empresaId, productoId]
    );
    const v = q.rows[0] ? n(q.rows[0].costo_unitario) : null;
    ultimaCompra.set(productoId, v);
    return v;
  }

  async function costear(c: Q, rid: string, camino: string[]): Promise<CosteoFormulacion> {
    const rq = await c.query(
      `SELECT r.id, r.producto_id, r.rendimiento_cantidad, r.rendimiento_unidad,
              COALESCE(r.merma_esperada_pct, 0) AS merma_esperada, p.nombre, p.precio_venta
         FROM ${t.R} r JOIN ${t.P} p ON p.id = r.producto_id
        WHERE r.id = $1::uuid AND r.empresa_id = $2::uuid`,
      [rid, empresaId]
    );
    const r = rq.rows[0];
    if (!r) throw new Error("Formulación no encontrada.");
    const items = await c.query(
      `SELECT ri.insumo_producto_id AS id, ri.cantidad, ri.unidad_medida, COALESCE(ri.merma_pct, 0) AS merma_pct,
              p.nombre, p.unidad_medida AS unidad_producto, p.costo_promedio,
              COALESCE(p.clase_producto, 'reventa') AS clase,
              (SELECT r2.id FROM ${t.R} r2 WHERE r2.producto_id = p.id AND r2.empresa_id = $2::uuid AND r2.activa
                ORDER BY r2.updated_at DESC LIMIT 1) AS receta_propia
         FROM ${t.RI} ri JOIN ${t.P} p ON p.id = ri.insumo_producto_id
        WHERE ri.receta_id = $1::uuid
        ORDER BY ri.orden`,
      [rid, empresaId]
    );

    const avisos: string[] = [];
    const out: CosteoItem[] = [];
    let costoLote = 0;
    for (const it of items.rows) {
      const pid = String(it.id);
      let costo = 0;
      let fuente: CosteoItem["fuente"] = "sin_costo";
      const recetaPropia = it.receta_propia ? String(it.receta_propia) : null;
      if (recetaPropia && it.clase === "intermedio" && !camino.includes(recetaPropia) && camino.length < 6) {
        const sub = await costear(c, recetaPropia, [...camino, recetaPropia]);
        costo = sub.costo_unitario;
        fuente = "formulacion";
        avisos.push(...sub.avisos);
      } else {
        if (recetaPropia && camino.includes(recetaPropia)) avisos.push(`"${it.nombre}" forma un ciclo con esta formulación: se usó su costo de stock.`);
        const uc = base === "ultima_compra" ? await costoUltimaCompra(c, pid) : null;
        if (uc != null && uc > 0) {
          costo = uc;
          fuente = "ultima_compra";
        } else if (n(it.costo_promedio) > 0) {
          costo = n(it.costo_promedio);
          fuente = "promedio";
          if (base === "ultima_compra") avisos.push(`"${it.nombre}" no tiene compras: se usó su costo promedio.`);
        } else {
          avisos.push(`"${it.nombre}" no tiene costo cargado.`);
        }
      }
      // Cantidad del ítem convertida a la unidad en la que está costeado el insumo.
      const unidadItem = it.unidad_medida ? String(it.unidad_medida) : null;
      const unidadProd = it.unidad_producto ? String(it.unidad_producto) : null;
      const conv = unidadItem && unidadProd ? convertirCantidad(n(it.cantidad), unidadItem, unidadProd) : n(it.cantidad);
      if (conv == null) avisos.push(`"${it.nombre}": la unidad ${unidadItem} no se puede pasar a ${unidadProd}.`);
      const cantidad = conv ?? n(it.cantidad);
      const sub = cantidad * (1 + n(it.merma_pct)) * costo;
      costoLote += sub;
      out.push({
        producto_id: pid,
        nombre: String(it.nombre),
        clase: String(it.clase),
        cantidad: n(it.cantidad),
        unidad: unidadItem,
        merma_pct: n(it.merma_pct),
        costo_unitario: r2(costo),
        fuente,
        subcosto: r2(sub),
      });
    }
    const esLaPedida = rid === recetaId;
    const rendBase = esLaPedida && vistaPrevia.rendimiento && vistaPrevia.rendimiento > 0 ? vistaPrevia.rendimiento : n(r.rendimiento_cantidad);
    const rendimiento = rendBase > 0 ? rendBase : 1;
    const mermaBase = esLaPedida && vistaPrevia.merma != null ? vistaPrevia.merma : n(r.merma_esperada);
    const mermaEsp = Math.min(0.95, Math.max(0, mermaBase));
    const unitario = costoLote / (rendimiento * (1 - mermaEsp));
    const precio = n(r.precio_venta);
    return {
      receta_id: rid,
      producto_id: String(r.producto_id),
      producto_nombre: String(r.nombre),
      base,
      rendimiento,
      rendimiento_unidad: r.rendimiento_unidad ? String(r.rendimiento_unidad) : null,
      merma_esperada: mermaEsp,
      costo_lote: r2(costoLote),
      costo_unitario: r2(unitario),
      precio_venta: precio,
      margen_pct: precio > 0 ? r2(((precio - unitario) / precio) * 100) : null,
      items: out,
      avisos: [...new Set(avisos)],
    };
  }

  const client = await pool.connect();
  try {
    return await costear(client as unknown as Q, recetaId, [recetaId]);
  } finally {
    client.release();
  }
}
