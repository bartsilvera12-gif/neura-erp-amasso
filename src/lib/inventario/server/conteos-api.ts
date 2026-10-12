import { NextRequest, NextResponse } from "next/server";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { esRolAdminEmpresaOGlobal } from "@/lib/auth/rol-empresa";
import { ConteoError } from "./conteos-pg";

/** Contexto de las rutas de conteo. `admin: true` = solo administradores (ajustar stock). */
export async function ctxConteo(request: NextRequest, opts: { admin?: boolean } = {}) {
  const auth = await getAuthWithRol(request);
  if (!auth) return { error: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) } as const;
  if (opts.admin && !esRolAdminEmpresaOGlobal(auth.rol)) {
    return {
      error: NextResponse.json(
        errorResponse("Solo un administrador puede ajustar el stock (cerrar un conteo)."),
        { status: 403 }
      ),
    } as const;
  }
  const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
  return { auth, schema, empresaId: auth.empresa_id } as const;
}

export function errorConteo(err: unknown, donde: string) {
  if (err instanceof ConteoError) return NextResponse.json(errorResponse(err.message), { status: err.status });
  const e = err as { code?: string; message?: string };
  if (e?.code === "42P01" || e?.code === "42703") {
    return NextResponse.json(
      errorResponse("Faltan las tablas de conteo (script supabase/amasso/11_requerimientos_produccion.sql)."),
      { status: 500 }
    );
  }
  console.error(`[conteos] ${donde}:`, e?.message ?? err);
  return NextResponse.json(errorResponse(e?.message ?? "Error inesperado."), { status: 500 });
}
