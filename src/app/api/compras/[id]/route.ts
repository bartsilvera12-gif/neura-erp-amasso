import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth, getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { eliminarCompraAnulada, updateCompraCuentaContable, updateCompraDatosFactura } from "@/lib/compras/server/compras-pg";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/compras/[id] — edición ACOTADA: la cuenta contable y los datos de
 * la factura (comprobante, timbrado, fecha, observación). No toca proveedor,
 * producto, montos ni el impacto en inventario: eso se corrige anulando y
 * cargando la compra de nuevo.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { id } = await context.params;
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const CAMPOS_FACTURA = ["tipo_comprobante", "numero_comprobante", "nro_timbrado", "fecha_factura", "observacion"];
    if (CAMPOS_FACTURA.some((k) => k in body)) {
      try {
        const ok = await updateCompraDatosFactura(schema, ctx.auth.empresa_id, id, body);
        if (!ok && !("cuenta_contable_id" in body)) {
          return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });
        }
      } catch (e) {
        return NextResponse.json(errorResponse(e instanceof Error ? e.message : "Datos inválidos."), { status: 400 });
      }
      if (!("cuenta_contable_id" in body)) return NextResponse.json(successResponse({ ok: true }));
    }
    if (!("cuenta_contable_id" in body)) {
      return NextResponse.json(errorResponse("No hay cambios para aplicar."), { status: 400 });
    }
    const raw = body.cuenta_contable_id;
    const cuentaContableId = raw == null || String(raw).trim() === "" ? null : String(raw);

    try {
      const compra = await updateCompraCuentaContable(schema, ctx.auth.empresa_id, id, cuentaContableId);
      if (!compra) return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });
      return NextResponse.json(successResponse({ compra }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "No se pudo actualizar la compra.";
      const code = (e as { code?: string })?.code;
      if (code === "23503") {
        return NextResponse.json(errorResponse("La cuenta contable seleccionada no existe."), { status: 400 });
      }
      return NextResponse.json(errorResponse(msg), { status: 400 });
    }
  } catch (err) {
    console.error("[/api/compras/[id] PATCH]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo actualizar la compra."), { status: 500 });
  }
}

/**
 * DELETE /api/compras/[id] — borra una compra ANULADA de la lista. Solo admin.
 * Para una compra vigente, primero se anula (POST /anular): eso devuelve el
 * stock y revierte el asiento.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!esRolAdminEmpresa(ctx.auth.rol)) {
      return NextResponse.json(errorResponse("Solo un administrador puede eliminar compras."), { status: 403 });
    }
    const { id } = await context.params;
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    await eliminarCompraAnulada(schema, ctx.auth.empresa_id, id);
    return NextResponse.json(successResponse({ eliminada: true }));
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    console.error("[/api/compras/[id] DELETE]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "No se pudo eliminar la compra."), { status });
  }
}
