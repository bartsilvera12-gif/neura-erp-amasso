import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { validarFecha } from "@/lib/rrhh/asistencia-pg";
import { detalleDia } from "@/lib/rrhh/marcaciones-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/marcaciones/dia?empleado&fecha — marcaciones y correcciones de un día. Solo admin. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const q = request.nextUrl.searchParams;
    const detalle = await detalleDia(c.schema, c.empresaId, String(q.get("empleado") ?? ""), validarFecha(q.get("fecha")));
    return NextResponse.json(successResponse(detalle));
  } catch (err) {
    return respuestaDeError(err, "GET marcaciones/dia");
  }
}
