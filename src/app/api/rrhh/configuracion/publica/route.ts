import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { leerConfig } from "@/lib/rrhh/config-pg";
import type { ConfigPublica } from "@/lib/rrhh/config-tipos";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * GET /api/rrhh/configuracion/publica — lo que el menú y la barra necesitan
 * saber (qué módulos se ven, si va el botón de marcar). Cualquier usuario.
 */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request);
  if ("error" in c) return c.error;
  try {
    const cfg = await leerConfig(c.schema, c.empresaId);
    const data: ConfigPublica & { es_admin: boolean } = { modulos: cfg.modulos, dispositivos: cfg.dispositivos, es_admin: c.esAdmin };
    return NextResponse.json(successResponse(data), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return respuestaDeError(err, "GET configuracion/publica");
  }
}
