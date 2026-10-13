import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { guardarConfig, leerConfig, ultimaModificacion } from "@/lib/rrhh/config-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/configuracion — configuración de asistencia. Solo admin. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const [config, modificada] = await Promise.all([leerConfig(c.schema, c.empresaId), ultimaModificacion(c.schema, c.empresaId)]);
    return NextResponse.json(successResponse({ config, modificada }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return respuestaDeError(err, "GET configuracion");
  }
}

/** PUT /api/rrhh/configuracion — guarda la configuración completa. Solo admin. */
export async function PUT(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as { config?: unknown };
    const config = await guardarConfig(c.schema, c.empresaId, body.config, c.usuarioNombre);
    const modificada = await ultimaModificacion(c.schema, c.empresaId);
    return NextResponse.json(successResponse({ config, modificada }));
  } catch (err) {
    return respuestaDeError(err, "PUT configuracion");
  }
}
