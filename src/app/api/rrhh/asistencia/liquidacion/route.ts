import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { liquidacionCsv, liquidacionDelMes } from "@/lib/rrhh/liquidacion-pg";
import { ctxRrhh, respuestaDeError } from "@/lib/rrhh/api-ctx";

/**
 * GET /api/rrhh/asistencia/liquidacion?mes=AAAA-MM[&formato=csv]
 * Liquidación de referencia para sueldos e IPS. Con `formato=csv` baja el archivo.
 * Solo admin: muestra sueldos.
 */
export async function GET(request: NextRequest) {
  const c = await ctxRrhh(request, { escribir: true });
  if ("error" in c) return c.error;
  try {
    const mes = request.nextUrl.searchParams.get("mes") ?? "";
    const filas = await liquidacionDelMes(c.schema, c.empresaId, mes);
    if (request.nextUrl.searchParams.get("formato") === "csv") {
      return new NextResponse(liquidacionCsv(mes, filas), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="liquidacion-${mes}.csv"`,
        },
      });
    }
    return NextResponse.json(successResponse({ filas }));
  } catch (err) {
    return respuestaDeError(err, "GET liquidación");
  }
}
