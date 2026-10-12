import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { saldoVacaciones } from "@/lib/rrhh/liquidacion-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/asistencia/vacaciones?anio=AAAA — días que corresponden y tomados. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request);
  if ("error" in c) return c.error;
  try {
    const anio = Number(request.nextUrl.searchParams.get("anio")) || new Date().getFullYear();
    return NextResponse.json(successResponse({ saldos: await saldoVacaciones(c.schema, c.empresaId, anio) }));
  } catch (err) {
    return respuestaDeError(err, "GET vacaciones");
  }
}
