import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { queryWithRetry } from "@/lib/supabase/pg-retry";
import { getAuthWithRol } from "@/lib/middleware/auth";
import {
  crearMovimientoPg,
  MovimientoError,
  type TipoMovimientoServidor,
} from "@/lib/inventario/server/movimientos-pg";

/**
 * GET /api/inventario/movimientos — lista movimientos via PG directo.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const schemaRaw = await fetchDataSchemaForEmpresaId(empresaId);
    const schema = assertAllowedChatDataSchema(schemaRaw);
    const pool = getChatPostgresPool();
    if (!pool) return NextResponse.json(errorResponse("Pool no disponible."), { status: 500 });
    const t = quoteSchemaTable(schema, "movimientos_inventario");
    const { rows } = await queryWithRetry(pool,
      `SELECT id, empresa_id, producto_id, producto_nombre, producto_sku,
              tipo, cantidad, costo_unitario, origen, referencia, fecha, created_at, updated_at,
              created_by, usuario_nombre
         FROM ${t}
        WHERE empresa_id = $1::uuid
        ORDER BY fecha DESC
        LIMIT 500`,
      [empresaId]
    );
    return NextResponse.json(successResponse({ movimientos: rows }));
  } catch (err) {
    console.error("[/api/inventario/movimientos GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar los movimientos."), { status: 500 });
  }
}

/**
 * POST /api/inventario/movimientos — alta manual de un movimiento.
 *
 * Body: { producto_id, tipo, cantidad, costo_unitario, origen, ubicacion_id?, referencia? }
 *
 * Va por acá y no desde el navegador a propósito: la escritura tiene que tocar
 * `productos.stock_actual` y `inventario_stock_ubicacion` dentro de una misma
 * transacción, con la fila del producto bloqueada. Ver `lib/inventario/server/movimientos-pg.ts`.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const productoId = body.producto_id ? String(body.producto_id) : "";
    if (!productoId) {
      return NextResponse.json(errorResponse("producto_id es obligatorio."), { status: 400 });
    }
    const tipo = String(body.tipo ?? "") as TipoMovimientoServidor;
    if (!["ENTRADA", "SALIDA", "AJUSTE"].includes(tipo)) {
      return NextResponse.json(errorResponse("tipo debe ser ENTRADA, SALIDA o AJUSTE."), {
        status: 400,
      });
    }
    const cantidad = Number(body.cantidad);
    if (!Number.isFinite(cantidad)) {
      return NextResponse.json(errorResponse("cantidad no es un número."), { status: 400 });
    }

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const res = await crearMovimientoPg({
      schema,
      empresaId: auth.empresa_id,
      productoId,
      tipo,
      cantidad,
      costoUnitario: Number(body.costo_unitario) || 0,
      origen: String(body.origen ?? "ajuste_manual"),
      referencia: body.referencia == null ? null : String(body.referencia).slice(0, 500),
      ubicacionId: body.ubicacion_id ? String(body.ubicacion_id) : null,
      usuarioId: auth.user?.id ?? null,
      usuarioNombre: auth.nombre ?? null,
    });

    return NextResponse.json(successResponse({ movimiento: res }));
  } catch (err) {
    if (err instanceof MovimientoError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/inventario/movimientos POST]", msg);
    return NextResponse.json(errorResponse("No se pudo registrar el movimiento."), { status: 500 });
  }
}
