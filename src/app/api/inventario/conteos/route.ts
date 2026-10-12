import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { abrirConteo, listarConteos } from "@/lib/inventario/server/conteos-pg";
import { ctxConteo, errorConteo } from "@/lib/inventario/server/conteos-api";

/** GET /api/inventario/conteos — últimos conteos físicos. */
export async function GET(request: NextRequest) {
  const c = await ctxConteo(request);
  if ("error" in c) return c.error;
  try {
    return NextResponse.json(successResponse({ conteos: await listarConteos(c.schema, c.empresaId) }));
  } catch (err) {
    return errorConteo(err, "GET");
  }
}

/** POST /api/inventario/conteos { ubicacion_id } — abre un conteo con la foto del stock. */
export async function POST(request: NextRequest) {
  const c = await ctxConteo(request);
  if ("error" in c) return c.error;
  try {
    const body = (await request.json().catch(() => ({}))) as { ubicacion_id?: string };
    const id = await abrirConteo(c.schema, c.empresaId, String(body.ubicacion_id ?? ""), c.auth.user?.id ?? null);
    return NextResponse.json(successResponse({ id }));
  } catch (err) {
    return errorConteo(err, "POST");
  }
}
