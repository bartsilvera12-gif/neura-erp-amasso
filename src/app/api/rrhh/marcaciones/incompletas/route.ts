import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { jornadasIncompletas } from "@/lib/rrhh/marcaciones-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/marcaciones/incompletas — jornadas pasadas sin salida. Solo admin. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const jornadas = await jornadasIncompletas(c.schema, c.empresaId);
    return NextResponse.json(successResponse({ jornadas }));
  } catch (err) {
    return respuestaDeError(err, "GET marcaciones/incompletas");
  }
}
