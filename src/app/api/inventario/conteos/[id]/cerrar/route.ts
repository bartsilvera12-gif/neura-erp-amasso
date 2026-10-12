import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { cerrarConteo } from "@/lib/inventario/server/conteos-pg";
import { ctxConteo, errorConteo } from "@/lib/inventario/server/conteos-api";

/** POST /api/inventario/conteos/[id]/cerrar — ajusta las diferencias. Solo admin. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await ctxConteo(request, { admin: true });
  if ("error" in c) return c.error;
  try {
    const { id } = await params;
    const res = await cerrarConteo(c.schema, c.empresaId, id, {
      id: c.auth.user?.id ?? null,
      nombre: c.auth.nombre ?? c.auth.user?.email ?? null,
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    return errorConteo(err, "cerrar");
  }
}
