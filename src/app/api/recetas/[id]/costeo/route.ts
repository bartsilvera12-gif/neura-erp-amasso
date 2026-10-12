import { NextRequest, NextResponse } from "next/server";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { costeoFormulacion } from "@/lib/recetas/costeo-pg";

/**
 * GET /api/recetas/[id]/costeo?base=promedio|ultima_compra
 * Costo teórico de la formulación, con los intermedios costeados por su propia
 * formulación.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthWithRol(request);
  if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
  try {
    const { id } = await params;
    const base = request.nextUrl.searchParams.get("base") === "ultima_compra" ? "ultima_compra" : "promedio";
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const costeo = await costeoFormulacion(schema, auth.empresa_id, id, base);
    return NextResponse.json(successResponse({ costeo }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/recetas/[id]/costeo]", msg);
    return NextResponse.json(errorResponse(msg), { status: msg.includes("no encontrada") ? 404 : 500 });
  }
}
