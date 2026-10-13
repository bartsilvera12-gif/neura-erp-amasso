import { NextRequest, NextResponse } from "next/server";
import { validarFecha } from "@/lib/rrhh/asistencia-pg";
import { listarMarcaciones, marcacionesCsv } from "@/lib/rrhh/marcaciones-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/** GET /api/rrhh/marcaciones/exportar?desde&hasta&empleado&tipo — CSV para Excel. Solo admin. */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const q = request.nextUrl.searchParams;
    const desde = validarFecha(q.get("desde"));
    const hasta = validarFecha(q.get("hasta"));
    const filas = await listarMarcaciones(c.schema, c.empresaId, {
      desde,
      hasta,
      empleadoId: q.get("empleado") || null,
      tipo: q.get("tipo") || null,
      incluirAnuladas: q.get("anuladas") === "1",
    });
    return new NextResponse(marcacionesCsv(filas), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="marcaciones_${desde}_${hasta}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return respuestaDeError(err, "GET marcaciones/exportar");
  }
}
