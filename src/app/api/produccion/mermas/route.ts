import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { listarMermas, registrarMerma, type OrigenMerma } from "@/lib/produccion/mermas-pg";
import { ctxProduccion, errorProduccion } from "@/lib/produccion/api-ctx";

/** GET /api/produccion/mermas — últimas mermas y devoluciones. */
export async function GET(request: NextRequest) {
  const c = await ctxProduccion(request);
  if ("error" in c) return c.error;
  try {
    return NextResponse.json(successResponse({ mermas: await listarMermas(c.schema, c.empresaId) }));
  } catch (err) {
    return errorProduccion(err, "GET mermas");
  }
}

/**
 * POST /api/produccion/mermas
 * { producto_id, cantidad, ubicacion_id, origen: "merma"|"devolucion"|"vencimiento",
 *   destino: "desecho"|"galleta_molida", producto_destino_id?, cantidad_destino?, motivo? }
 */
export async function POST(request: NextRequest) {
  const c = await ctxProduccion(request);
  if ("error" in c) return c.error;
  try {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const origen = (["merma", "devolucion", "vencimiento"] as const).includes(b.origen as never)
      ? (b.origen as OrigenMerma)
      : "merma";
    const r = await registrarMerma(c.schema, c.empresaId, {
      productoId: String(b.producto_id ?? ""),
      cantidad: Number(b.cantidad),
      ubicacionId: String(b.ubicacion_id ?? ""),
      origen,
      destino: b.destino === "galleta_molida" ? "galleta_molida" : "desecho",
      productoDestinoId: b.producto_destino_id ? String(b.producto_destino_id) : null,
      cantidadDestino: b.cantidad_destino == null || b.cantidad_destino === "" ? null : Number(b.cantidad_destino),
      motivo: b.motivo == null ? null : String(b.motivo),
      usuarioId: c.usuarioId,
      usuarioNombre: c.usuarioNombre,
    });
    return NextResponse.json(successResponse(r));
  } catch (err) {
    return errorProduccion(err, "POST merma");
  }
}
