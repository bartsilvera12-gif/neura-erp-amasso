import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { guardarAsistencia, planillaDelDia } from "@/lib/rrhh/asistencia-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/asistencia?fecha=AAAA-MM-DD — planilla del día. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request);
  if ("error" in c) return c.error;
  try {
    const filas = await planillaDelDia(c.schema, c.empresaId, request.nextUrl.searchParams.get("fecha"));
    return NextResponse.json(successResponse({ filas }));
  } catch (err) {
    return respuestaDeError(err, "GET asistencia");
  }
}

/**
 * PUT /api/rrhh/asistencia — crea o actualiza el registro de un empleado en un
 * día. Body: { empleado_id, fecha, estado?, entrada?: "HH:MM", salida?: "HH:MM",
 * observacion? }. Solo cambia lo que viene. Solo admin.
 */
export async function PUT(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    await guardarAsistencia(c.schema, c.empresaId, body, await c.usuarioId());
    const filas = await planillaDelDia(c.schema, c.empresaId, body.fecha);
    return NextResponse.json(successResponse({ filas }));
  } catch (err) {
    return respuestaDeError(err, "PUT asistencia");
  }
}
