import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { detalleStockDeUbicacion } from "@/lib/inventario/server/movimientos-pg";

type RouteCtx = { params: Promise<{ id: string }> };

/** GET /api/inventario/ubicaciones/[id]/stock — qué hay en esa ubicación, producto por producto. */
export async function GET(request: NextRequest, { params }: RouteCtx) {
  try {
    const { id } = await params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const rows = await detalleStockDeUbicacion(schema, ctx.auth.empresa_id, id);
    return NextResponse.json(successResponse({ stock: rows }));
  } catch (err) {
    console.error("[ubicaciones/stock GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar el stock de la ubicación."), { status: 500 });
  }
}
