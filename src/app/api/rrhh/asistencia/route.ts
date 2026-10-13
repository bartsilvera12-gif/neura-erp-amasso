import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { AsistenciaError, guardarAsistencia, planillaDelDia, validarFecha } from "@/lib/rrhh/asistencia-pg";
import { tieneMarcaciones } from "@/lib/rrhh/marcaciones-pg";
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
 * día. Body: { empleado_id, fecha, estado?, observacion?, justificada? }. Las
 * horas no: salen de las marcaciones. Solo cambia lo que viene. Solo admin.
 */
export async function PUT(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // Las horas salen de las marcaciones. Para cambiarlas está la corrección,
    // que pide motivo y deja registro; acá solo se pone el estado del día.
    if ("entrada" in body || "salida" in body) {
      throw new AsistenciaError("Las horas se corrigen desde Marcaciones, con motivo.");
    }
    const estado = String(body.estado ?? "");
    if (estado && !["presente", "tarde"].includes(estado)) {
      const hay = await tieneMarcaciones(c.schema, c.empresaId, String(body.empleado_id ?? ""), validarFecha(body.fecha));
      if (hay) {
        throw new AsistenciaError("Ese día tiene marcaciones. Para ponerlo como ausencia, anulalas primero desde Marcaciones.", 409);
      }
    }
    await guardarAsistencia(c.schema, c.empresaId, body, await c.usuarioId());
    const filas = await planillaDelDia(c.schema, c.empresaId, body.fecha);
    return NextResponse.json(successResponse({ filas }));
  } catch (err) {
    return respuestaDeError(err, "PUT asistencia");
  }
}
