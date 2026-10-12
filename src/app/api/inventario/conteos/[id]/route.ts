import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { detalleConteo, guardarConteoItems } from "@/lib/inventario/server/conteos-pg";
import { ctxConteo, errorConteo } from "@/lib/inventario/server/conteos-api";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/inventario/conteos/[id] — conteo con sus renglones. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const c = await ctxConteo(request);
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    return NextResponse.json(successResponse(await detalleConteo(c.schema, c.empresaId, id)));
  } catch (err) {
    return errorConteo(err, "GET detalle");
  }
}

/** PATCH /api/inventario/conteos/[id] { items: [{ id, cantidad_contada, motivo }] } — guarda lo contado. */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const c = await ctxConteo(request);
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { items?: [] };
    await guardarConteoItems(c.schema, c.empresaId, id, Array.isArray(body.items) ? body.items : []);
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return errorConteo(err, "PATCH");
  }
}
