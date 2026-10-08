import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { actualizarEmpleado } from "@/lib/rrhh/asistencia-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * PATCH /api/rrhh/empleados/[id] — edición y baja (`activo: false`). Solo admin.
 * No hay DELETE: borrar un empleado borraría su historial de asistencia.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const empleado = await actualizarEmpleado(c.schema, c.empresaId, id, body);
    return NextResponse.json(successResponse({ empleado }));
  } catch (err) {
    return respuestaDeError(err, "PATCH empleado");
  }
}
