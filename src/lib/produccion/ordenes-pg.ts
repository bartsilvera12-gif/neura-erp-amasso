import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { crearProduccionPg, previewProduccion, ProduccionError, type ProduccionPreview } from "./crear-produccion-pg";
import { registrarMerma, type DestinoMerma } from "./mermas-pg";

/**
 * Órdenes de producción: Planificada → En proceso → Finalizada (o Cancelada).
 *
 * Una orden es una fila de `producciones` que todavía no movió stock. Se crea
 * con producto, cantidad y depósito; el sistema calcula la materia prima según
 * la formulación y avisa si falta. Recién al finalizar se descuenta la materia
 * prima del depósito y entra lo producido (ver `crearProduccionPg`), con su
 * lote y vencimiento.
 */

export type EstadoOrden = "planificada" | "en_proceso" | "finalizada" | "cancelada";

export type OrdenFila = {
  id: string;
  numero: string | null;
  estado: EstadoOrden;
  receta_id: string | null;
  producto_id: string;
  producto_nombre: string;
  unidad: string | null;
  cantidad_planificada: number | null;
  cantidad_fabricada: number;
  merma_cantidad: number;
  lote: string | null;
  fecha_vencimiento: string | null;
  ubicacion_id: string | null;
  ubicacion_nombre: string | null;
  costo_total: number;
  costo_unitario: number;
  fecha: string;
  usuario_nombre: string | null;
  observaciones: string | null;
};

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new ProduccionError("No hay conexión directa a Postgres.", 500);
  return p;
}

export async function listarOrdenes(schemaRaw: string, empresaId: string): Promise<OrdenFila[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "producciones");
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");
  const tP = quoteSchemaTable(schema, "productos");
  const { rows } = await pool().query<OrdenFila>(
    `SELECT o.id, o.numero, o.estado, o.receta_id, o.producto_id, o.producto_nombre, p.unidad_medida AS unidad,
            o.cantidad_planificada::float8 AS cantidad_planificada, o.cantidad_fabricada::float8 AS cantidad_fabricada,
            o.merma_cantidad::float8 AS merma_cantidad, o.lote, o.fecha_vencimiento::text AS fecha_vencimiento,
            o.ubicacion_id, u.nombre AS ubicacion_nombre, o.costo_total::float8 AS costo_total,
            o.costo_unitario::float8 AS costo_unitario, o.fecha::text AS fecha, o.usuario_nombre, o.observaciones
       FROM ${t} o
       LEFT JOIN ${tU} u ON u.id = o.ubicacion_id
       LEFT JOIN ${tP} p ON p.id = o.producto_id
      WHERE o.empresa_id = $1::uuid
      ORDER BY (o.estado IN ('planificada', 'en_proceso')) DESC, o.fecha DESC
      LIMIT 200`,
    [empresaId]
  );
  return rows;
}

/** Crea la orden (sin mover stock) y devuelve el cálculo de materia prima. */
export async function crearOrden(
  schemaRaw: string,
  empresaId: string,
  d: {
    recetaId: string;
    cantidad: number;
    ubicacionId: string;
    observaciones?: string | null;
    usuarioId: string | null;
    usuarioNombre: string | null;
  }
): Promise<{ id: string; numero: string; preview: ProduccionPreview }> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  if (!d.ubicacionId) throw new ProduccionError("Elegí el depósito donde se produce (Fábrica o Punto de venta).");
  const preview = await previewProduccion({
    schema,
    empresaId,
    recetaId: d.recetaId,
    cantidadFabricar: d.cantidad,
    ubicacionId: d.ubicacionId,
  });
  const t = quoteSchemaTable(schema, "producciones");
  const sec = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${t} WHERE empresa_id = $1::uuid AND numero IS NOT NULL`,
    [empresaId]
  );
  const numero = `OP-${String(Number(sec.rows[0]?.n ?? 0) + 1).padStart(6, "0")}`;
  const ins = await pool().query<{ id: string }>(
    `INSERT INTO ${t} (empresa_id, receta_id, producto_id, producto_nombre, cantidad_fabricada,
       rendimiento_cantidad, unidad_rendimiento, costo_total, costo_unitario, usuario_id, usuario_nombre,
       observaciones, estado, numero, cantidad_planificada, ubicacion_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 0, $5::numeric, $6, $7::numeric, $8::numeric, $9::uuid, $10,
             $11, 'planificada', $12, $13::numeric, $14::uuid)
     RETURNING id`,
    [empresaId, preview.receta_id, preview.producto_id, preview.producto_nombre, preview.rendimiento_cantidad,
     preview.unidad_rendimiento, preview.costo_total, preview.costo_unitario, d.usuarioId, d.usuarioNombre,
     d.observaciones?.trim() || null, numero, d.cantidad, d.ubicacionId]
  );
  return { id: ins.rows[0].id, numero, preview };
}

async function ordenDe(schemaRaw: string, empresaId: string, id: string) {
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "producciones");
  const { rows } = await pool().query<{
    estado: EstadoOrden; receta_id: string | null; cantidad_planificada: string | null; ubicacion_id: string | null;
  }>(
    `SELECT estado, receta_id, cantidad_planificada::text, ubicacion_id FROM ${t}
      WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId]
  );
  if (!rows[0]) throw new ProduccionError("Orden no encontrada.", 404);
  return rows[0];
}

/** Recalcula la materia prima de una orden abierta (para ver faltantes al día). */
export async function previewOrden(schemaRaw: string, empresaId: string, id: string): Promise<ProduccionPreview> {
  const o = await ordenDe(schemaRaw, empresaId, id);
  if (!o.receta_id) throw new ProduccionError("La orden no tiene formulación.");
  return previewProduccion({
    schema: schemaRaw,
    empresaId,
    recetaId: o.receta_id,
    cantidadFabricar: Number(o.cantidad_planificada),
    ubicacionId: o.ubicacion_id,
  });
}

export async function cambiarEstadoOrden(
  schemaRaw: string,
  empresaId: string,
  id: string,
  nuevo: "en_proceso" | "cancelada"
): Promise<void> {
  const o = await ordenDe(schemaRaw, empresaId, id);
  const permitido =
    (nuevo === "en_proceso" && o.estado === "planificada") ||
    (nuevo === "cancelada" && (o.estado === "planificada" || o.estado === "en_proceso"));
  if (!permitido) throw new ProduccionError(`No se puede pasar de "${o.estado}" a "${nuevo}".`, 409);
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "producciones");
  await pool().query(
    `UPDATE ${t} SET estado = $1, iniciada_at = CASE WHEN $1 = 'en_proceso' THEN now() ELSE iniciada_at END,
            updated_at = now()
      WHERE id = $2::uuid AND empresa_id = $3::uuid`,
    [nuevo, id, empresaId]
  );
}

/**
 * Finaliza: registra lo que salió y las mermas, descuenta la materia prima del
 * depósito y suma lo producido con lote y vencimiento.
 */
export async function finalizarOrden(
  schemaRaw: string,
  empresaId: string,
  id: string,
  d: {
    cantidadReal: number;
    mermaCantidad?: number | null;
    mermaDestino?: DestinoMerma | null;
    /** Si la merma va a galleta molida: el producto intermedio que la recibe. */
    galletaProductoId?: string | null;
    galletaCantidad?: number | null;
    permitirSinStock?: boolean;
    usuarioId: string | null;
    usuarioNombre: string | null;
  }
) {
  const o = await ordenDe(schemaRaw, empresaId, id);
  if (o.estado !== "planificada" && o.estado !== "en_proceso") {
    throw new ProduccionError("La orden ya está finalizada o cancelada.", 409);
  }
  if (!o.receta_id || !o.ubicacion_id) throw new ProduccionError("La orden no tiene formulación o depósito.");
  const merma = Math.max(0, Number(d.mermaCantidad) || 0);
  if (merma > 0 && !d.mermaDestino) {
    throw new ProduccionError("Indicá el destino de la merma: desecho o galleta molida.");
  }

  const res = await crearProduccionPg({
    schema: schemaRaw,
    empresaId,
    recetaId: o.receta_id,
    cantidadFabricar: Number(o.cantidad_planificada),
    cantidadObtenida: d.cantidadReal,
    mermaCantidad: merma,
    ubicacionId: o.ubicacion_id,
    ordenId: id,
    permitirSinStock: d.permitirSinStock,
    usuarioId: d.usuarioId,
    usuarioNombre: d.usuarioNombre,
  });

  // El destino de la merma va aparte: la producción ya quedó firme y no se
  // deshace si esto falla; se avisa para registrarlo a mano desde Mermas.
  let avisoMerma: string | null = null;
  if (merma > 0 && d.mermaDestino) {
    try {
      await registrarMerma(schemaRaw, empresaId, {
        productoId: res.producto_id,
        cantidad: merma,
        ubicacionId: o.ubicacion_id,
        origen: "produccion",
        destino: d.mermaDestino,
        productoDestinoId: d.galletaProductoId ?? null,
        cantidadDestino: d.galletaCantidad ?? null,
        produccionId: id,
        motivo: `Merma de la orden ${res.lote}`,
        usuarioId: d.usuarioId,
        usuarioNombre: d.usuarioNombre,
      });
    } catch (e) {
      avisoMerma = `La producción quedó registrada, pero no se pudo registrar el destino de la merma: ${
        e instanceof Error ? e.message : String(e)
      }. Cargala desde Producción › Mermas.`;
    }
  }
  return { ...res, aviso_merma: avisoMerma };
}
