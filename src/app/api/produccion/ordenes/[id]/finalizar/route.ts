import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { finalizarOrden } from "@/lib/produccion/ordenes-pg";
import { ctxProduccion, errorProduccion } from "@/lib/produccion/api-ctx";

/**
 * POST /api/produccion/ordenes/[id]/finalizar
 * { cantidad_real, merma_cantidad?, merma_destino?: "desecho" | "galleta_molida",
 *   galleta_producto_id?, galleta_cantidad?, permitir_sin_stock? }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await ctxProduccion(request);
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const destino = b.merma_destino === "desecho" || b.merma_destino === "galleta_molida" ? b.merma_destino : null;
    const r = await finalizarOrden(c.schema, c.empresaId, id, {
      cantidadReal: Number(b.cantidad_real),
      mermaCantidad: b.merma_cantidad == null ? null : Number(b.merma_cantidad),
      mermaDestino: destino,
      galletaProductoId: b.galleta_producto_id ? String(b.galleta_producto_id) : null,
      galletaCantidad: b.galleta_cantidad == null || b.galleta_cantidad === "" ? null : Number(b.galleta_cantidad),
      permitirSinStock: b.permitir_sin_stock === true,
      usuarioId: c.usuarioId,
      usuarioNombre: c.usuarioNombre,
    });
    return NextResponse.json(successResponse({ produccion: r }));
  } catch (err) {
    return errorProduccion(err, "finalizar orden");
  }
}
