import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { registrarRango } from "@/lib/rrhh/liquidacion-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** POST /api/rrhh/asistencia/rango { empleado_id, desde, hasta, estado, justificada?, observacion? } — solo admin. */
export async function POST(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const dias = await registrarRango(
      c.schema,
      c.empresaId,
      { empleado_id: body.empleado_id, desde: body.desde, hasta: body.hasta, estado: body.estado, justificada: body.justificada, observacion: body.observacion },
      await c.usuarioId()
    );
    return NextResponse.json(successResponse({ dias }));
  } catch (err) {
    return respuestaDeError(err, "POST rango");
  }
}
