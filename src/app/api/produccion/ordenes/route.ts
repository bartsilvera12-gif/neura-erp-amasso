import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { crearOrden, listarOrdenes } from "@/lib/produccion/ordenes-pg";
import { ctxProduccion, errorProduccion } from "@/lib/produccion/api-ctx";

/** GET /api/produccion/ordenes — abiertas primero, después el historial. */
export async function GET(request: NextRequest) {
  const c = await ctxProduccion(request);
  if ("error" in c) return c.error;
  try {
    return NextResponse.json(successResponse({ ordenes: await listarOrdenes(c.schema, c.empresaId) }));
  } catch (err) {
    return errorProduccion(err, "GET ordenes");
  }
}

/** POST /api/produccion/ordenes { receta_id, cantidad, ubicacion_id, observaciones? } */
export async function POST(request: NextRequest) {
  const c = await ctxProduccion(request);
  if ("error" in c) return c.error;
  try {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await crearOrden(c.schema, c.empresaId, {
      recetaId: String(b.receta_id ?? ""),
      cantidad: Number(b.cantidad),
      ubicacionId: String(b.ubicacion_id ?? ""),
      observaciones: b.observaciones == null ? null : String(b.observaciones),
      usuarioId: c.usuarioId,
      usuarioNombre: c.usuarioNombre,
    });
    return NextResponse.json(successResponse(r));
  } catch (err) {
    return errorProduccion(err, "POST orden");
  }
}
