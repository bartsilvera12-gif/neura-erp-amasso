import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resumenDelMes } from "@/lib/rrhh/asistencia-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/asistencia/resumen?mes=AAAA-MM — totales del mes por empleado. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request);
  if ("error" in c) return c.error;
  try {
    const resumen = await resumenDelMes(c.schema, c.empresaId, request.nextUrl.searchParams.get("mes"));
    return NextResponse.json(successResponse({ resumen }));
  } catch (err) {
    return respuestaDeError(err, "GET resumen asistencia");
  }
}
