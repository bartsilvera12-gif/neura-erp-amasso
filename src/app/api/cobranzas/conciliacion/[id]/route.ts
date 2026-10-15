import { NextRequest, NextResponse } from "next/server";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCobranzasApiAccess } from "@/lib/contabilidad/contabilidad-auth";
import { ConciliacionError, editarCobroPendiente, eliminarCobro } from "@/lib/cobranzas/conciliacion-pg";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

/** PATCH — corrige un cobro pendiente (monto, fecha, banco, titular, N.º de operación). */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await requireCobranzasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  try {
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresaId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const cobro = await editarCobroPendiente(schema, auth.empresaId, id, body);
    return NextResponse.json(successResponse({ cobro }));
  } catch (e) {
    if (e instanceof ConciliacionError) return NextResponse.json(errorResponse(e.message), { status: e.status });
    console.error("[conciliacion/[id] PATCH]", e instanceof Error ? e.message : e);
    return NextResponse.json(errorResponse("No se pudo guardar el cambio."), { status: 500 });
  }
}

/** DELETE — borra de la lista un cobro rechazado o anulado. */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await requireCobranzasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  try {
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresaId);
    await eliminarCobro(schema, auth.empresaId, id);
    return NextResponse.json(successResponse({ eliminado: true }));
  } catch (e) {
    if (e instanceof ConciliacionError) return NextResponse.json(errorResponse(e.message), { status: e.status });
    console.error("[conciliacion/[id] DELETE]", e instanceof Error ? e.message : e);
    return NextResponse.json(errorResponse("No se pudo borrar el cobro."), { status: 500 });
  }
}
