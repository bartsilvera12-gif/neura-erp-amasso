import { NextRequest, NextResponse } from "next/server";
import { errorResponse, successResponse } from "@/lib/api/response";
import { validarFecha } from "@/lib/rrhh/asistencia-pg";
import { corregir, detalleDia, type Correccion } from "@/lib/rrhh/marcaciones-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * POST /api/rrhh/marcaciones/corregir — corrección de un administrador.
 * Body: { empleado_id, fecha, accion: "agregar"|"modificar"|"anular", tipo?, evento_id?, hora?, motivo }.
 * Queda quién, cuándo, el motivo y el valor anterior y el nuevo.
 */
export async function POST(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const empleadoId = String(b.empleado_id ?? "");
    const fecha = validarFecha(b.fecha);
    const accion = String(b.accion ?? "");
    if (!["agregar", "modificar", "anular"].includes(accion)) {
      return NextResponse.json(errorResponse("Acción inválida."), { status: 400 });
    }
    const cor: Correccion =
      accion === "agregar"
        ? { accion, tipo: String(b.tipo ?? "") as never, hora: String(b.hora ?? ""), horaFin: b.hora_fin ? String(b.hora_fin) : null }
        : accion === "modificar"
          ? { accion, eventoId: String(b.evento_id ?? ""), hora: String(b.hora ?? "") }
          : { accion: "anular", eventoId: String(b.evento_id ?? "") };
    await corregir(c.schema, c.empresaId, empleadoId, fecha, cor, b.motivo, {
      id: await c.usuarioId(),
      nombre: c.usuarioNombre,
    });
    const detalle = await detalleDia(c.schema, c.empresaId, empleadoId, fecha);
    return NextResponse.json(successResponse(detalle));
  } catch (err) {
    return respuestaDeError(err, "POST marcaciones/corregir");
  }
}
