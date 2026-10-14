import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { actualizarEmpleado, eliminarEmpleado } from "@/lib/rrhh/asistencia-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * PATCH /api/rrhh/empleados/[id] — edición y baja (`activo: false`). Solo admin.
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

/**
 * DELETE /api/rrhh/empleados/[id][?confirmar=1] — borra un empleado dado de
 * baja, con su historial de asistencia. Sin `confirmar` solo devuelve cuánto
 * historial tiene, para avisar antes. Solo admin.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    const confirmar = request.nextUrl.searchParams.get("confirmar") === "1";
    const historial = await eliminarEmpleado(c.schema, c.empresaId, id, confirmar);
    return NextResponse.json(successResponse({ historial, borrado: confirmar }));
  } catch (err) {
    return respuestaDeError(err, "DELETE empleado");
  }
}
