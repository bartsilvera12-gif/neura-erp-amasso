import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { identificar } from "@/lib/rrhh/marcaciones-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * POST /api/rrhh/marcar/identificar — el empleado se identifica para marcar.
 * Body: { cedula, codigo, pin? }. Cualquier sesión abierta de la empresa sirve:
 * no cambia ni usa la identidad del usuario logueado. Devuelve el nombre, el
 * estado de su jornada y qué puede marcar. Datos en el body, nunca en la URL.
 */
export async function POST(request: NextRequest) {
  const c = await ctxRrhh(request);
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const data = await identificar(c.schema, c.empresaId, body, c.claveSesion);
    return NextResponse.json(successResponse(data), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return respuestaDeError(err, "POST marcar/identificar");
  }
}
