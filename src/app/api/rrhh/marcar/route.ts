import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { marcar } from "@/lib/rrhh/marcaciones-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * POST /api/rrhh/marcar — registra una marcación del empleado.
 * Body: { cedula, codigo, pin?, tipo }. La hora es la del servidor. Queda a
 * nombre del empleado; del usuario logueado solo se guarda quién era y el
 * dispositivo, para auditoría.
 */
export async function POST(request: NextRequest) {
  const c = await ctxRrhh(request);
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const resultado = await marcar(c.schema, c.empresaId, body, body.tipo, {
      usuarioId: await c.usuarioId(),
      usuarioNombre: c.usuarioNombre,
      dispositivo: request.headers.get("user-agent"),
      clave: c.claveSesion,
    });
    return NextResponse.json(successResponse(resultado), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return respuestaDeError(err, "POST marcar");
  }
}
