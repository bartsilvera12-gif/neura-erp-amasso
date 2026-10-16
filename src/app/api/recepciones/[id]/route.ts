import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth, getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { conMotivo } from "@/lib/api/motivo-error";
import {
  anularRecepcion,
  editarRecepcion,
  eliminarRecepcion,
  getRecepcion,
  RecepcionError,
} from "@/lib/recepciones/server/recepciones-pg";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { id } = await context.params;
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const data = await getRecepcion(schema, ctx.auth.empresa_id, id);
    if (!data) return NextResponse.json(errorResponse("Recepción no encontrada."), { status: 404 });
    return NextResponse.json(successResponse(data));
  } catch (err) {
    console.error("[/api/recepciones/[id] GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse(conMotivo("No se pudo cargar la recepción.", err)), { status: 500 });
  }
}

async function soloAdmin(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuthWithRol(request);
  if (!ctx) return { error: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) } as const;
  if (!esRolAdminEmpresa(ctx.auth.rol)) {
    return { error: NextResponse.json(errorResponse("Solo un administrador puede hacer esto."), { status: 403 }) } as const;
  }
  return { ctx } as const;
}

function errorDe(e: unknown, contexto: string) {
  if (e instanceof RecepcionError) return NextResponse.json(errorResponse(e.message), { status: e.status });
  console.error(`[/api/recepciones/[id] ${contexto}]`, e instanceof Error ? e.message : e);
  return NextResponse.json(errorResponse("No se pudo completar la operación."), { status: 500 });
}

/**
 * PATCH /api/recepciones/[id]
 *  - { accion: "anular", motivo } → revierte el stock que entró. Solo admin.
 *  - { fecha?, observacion?, documento_url?, ubicacion_id?, items? } → edición; si cambian
 *    cantidades o depósito, el stock se ajusta en la misma transacción. Solo admin.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const a = await soloAdmin(request);
  if ("error" in a) return a.error;
  try {
    const { id } = await context.params;
    const schema = await fetchDataSchemaForEmpresaId(a.ctx.auth.empresa_id);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.accion === "anular") {
      await anularRecepcion(schema, a.ctx.auth.empresa_id, id, String(body.motivo ?? ""), {
        id: null,
        nombre: a.ctx.auth.nombre ?? a.ctx.auth.user?.email ?? null,
      });
    } else {
      await editarRecepcion(schema, a.ctx.auth.empresa_id, id, body, {
        id: null,
        nombre: a.ctx.auth.nombre ?? a.ctx.auth.user?.email ?? null,
      });
    }
    return NextResponse.json(successResponse({ ok: true }));
  } catch (e) {
    return errorDe(e, "PATCH");
  }
}

/** DELETE /api/recepciones/[id] — borra una recepción anulada. Solo admin. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const a = await soloAdmin(request);
  if ("error" in a) return a.error;
  try {
    const { id } = await context.params;
    const schema = await fetchDataSchemaForEmpresaId(a.ctx.auth.empresa_id);
    await eliminarRecepcion(schema, a.ctx.auth.empresa_id, id);
    return NextResponse.json(successResponse({ eliminada: true }));
  } catch (e) {
    return errorDe(e, "DELETE");
  }
}
