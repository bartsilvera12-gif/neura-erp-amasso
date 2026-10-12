import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { cambiarEstadoOrden, previewOrden } from "@/lib/produccion/ordenes-pg";
import { ctxProduccion, errorProduccion } from "@/lib/produccion/api-ctx";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/produccion/ordenes/[id] — materia prima necesaria y faltantes, al día. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const c = await ctxProduccion(request);
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    return NextResponse.json(successResponse({ preview: await previewOrden(c.schema, c.empresaId, id) }));
  } catch (err) {
    return errorProduccion(err, "GET preview orden");
  }
}

/** PATCH /api/produccion/ordenes/[id] { accion: "iniciar" | "cancelar" } */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const c = await ctxProduccion(request);
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    const b = (await request.json().catch(() => ({}))) as { accion?: string };
    if (b.accion !== "iniciar" && b.accion !== "cancelar") {
      return NextResponse.json(errorResponse("Acción inválida."), { status: 400 });
    }
    await cambiarEstadoOrden(c.schema, c.empresaId, id, b.accion === "iniciar" ? "en_proceso" : "cancelada");
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return errorProduccion(err, "PATCH orden");
  }
}
