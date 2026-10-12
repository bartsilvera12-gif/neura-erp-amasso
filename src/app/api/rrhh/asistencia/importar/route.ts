import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { parseUploadFile } from "@/lib/excel/import";
import { importarHistorial } from "@/lib/rrhh/importar-historial";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * POST /api/rrhh/asistencia/importar (multipart: archivo, crear_empleados)
 * Importa el historial de asistencia desde Excel o CSV. Solo admin.
 */
export async function POST(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const form = await request.formData();
    const file = form.get("archivo");
    if (!(file instanceof File)) return NextResponse.json(errorResponse("Falta el archivo."), { status: 400 });
    const parsed = await parseUploadFile(file);
    if ("error" in parsed) return NextResponse.json(errorResponse(parsed.error), { status: 400 });
    const res = await importarHistorial(c.schema, c.empresaId, parsed.rows, {
      crearEmpleados: form.get("crear_empleados") === "1",
      registradoPor: await c.usuarioId(),
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    return respuestaDeError(err, "importar historial");
  }
}
