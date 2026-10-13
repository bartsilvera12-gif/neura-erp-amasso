import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { validarFecha } from "@/lib/rrhh/asistencia-pg";
import { listarMarcaciones } from "@/lib/rrhh/marcaciones-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/marcaciones?desde&hasta&empleado&tipo&anuladas=1 — listado. Solo admin. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const q = request.nextUrl.searchParams;
    const marcaciones = await listarMarcaciones(c.schema, c.empresaId, {
      desde: validarFecha(q.get("desde")),
      hasta: validarFecha(q.get("hasta")),
      empleadoId: q.get("empleado") || null,
      tipo: q.get("tipo") || null,
      incluirAnuladas: q.get("anuladas") === "1",
    });
    return NextResponse.json(successResponse({ marcaciones }));
  } catch (err) {
    return respuestaDeError(err, "GET marcaciones");
  }
}
