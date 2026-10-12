import { NextRequest, NextResponse } from "next/server";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getAuthWithRol } from "@/lib/middleware/auth";
import {
  listarTransferencias,
  transferirStock,
  TransferenciaError,
  type TransferenciaItem,
} from "@/lib/inventario/server/transferencias-pg";

/** GET /api/inventario/transferencias — últimas transferencias entre depósitos. */
export async function GET(request: NextRequest) {
  const auth = await getAuthWithRol(request);
  if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
  try {
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const transferencias = await listarTransferencias(schema, auth.empresa_id);
    return NextResponse.json(successResponse({ transferencias }));
  } catch (err) {
    console.error("[/api/inventario/transferencias GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las transferencias."), { status: 500 });
  }
}

/**
 * POST /api/inventario/transferencias
 * Body: { origen_id, destino_id, items: [{ producto_id, cantidad }], observacion? }
 */
export async function POST(request: NextRequest) {
  const auth = await getAuthWithRol(request);
  if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const res = await transferirStock(schema, auth.empresa_id, {
      origenId: String(body.origen_id ?? ""),
      destinoId: String(body.destino_id ?? ""),
      items: Array.isArray(body.items) ? (body.items as TransferenciaItem[]) : [],
      observacion: body.observacion == null ? null : String(body.observacion),
      usuarioId: auth.user?.id ?? null,
      usuarioNombre: auth.nombre ?? null,
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/inventario/transferencias POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo registrar la transferencia."), { status: 500 });
  }
}
