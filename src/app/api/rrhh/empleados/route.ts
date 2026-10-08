import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { crearEmpleado, listarEmpleados } from "@/lib/rrhh/asistencia-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/empleados[?todos=1] — nómina (por defecto, solo activos). */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request);
  if ("error" in c) return c.error;
  try {
    const todos = request.nextUrl.searchParams.get("todos") === "1";
    const empleados = await listarEmpleados(c.schema, c.empresaId, todos);
    return NextResponse.json(successResponse({ empleados }));
  } catch (err) {
    return respuestaDeError(err, "GET empleados");
  }
}

/** POST /api/rrhh/empleados — alta de empleado. Solo admin. */
export async function POST(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const empleado = await crearEmpleado(c.schema, c.empresaId, body);
    return NextResponse.json(successResponse({ empleado }));
  } catch (err) {
    return respuestaDeError(err, "POST empleados");
  }
}
