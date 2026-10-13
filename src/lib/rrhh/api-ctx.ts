import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { usuarioDelSchema } from "@/lib/repartos/server/repartos-pg";
import { AsistenciaError } from "./asistencia-pg";

/**
 * Contexto común de las rutas de RRHH. Leer lo puede cualquiera de la empresa;
 * escribir (alta de empleados, marcar asistencia) solo un administrador: la
 * asistencia termina en sueldos y descuentos, no la marca cualquiera.
 */
export async function ctxRrhh(request: NextRequest, opts: { escribir?: boolean } = {}) {
  const ctx = await getTenantSupabaseFromAuthWithRol(request);
  if (!ctx) {
    return { error: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) } as const;
  }
  if (opts.escribir && !esRolAdminEmpresa(ctx.auth.rol)) {
    return {
      error: NextResponse.json(errorResponse("Solo un administrador puede modificar RRHH."), { status: 403 }),
    } as const;
  }
  const empresaId = ctx.auth.empresa_id;
  const schema = assertAllowedChatDataSchema(await fetchDataSchemaForEmpresaId(empresaId));
  return {
    empresaId,
    schema,
    esAdmin: esRolAdminEmpresa(ctx.auth.rol),
    usuarioNombre: ctx.auth.nombre ?? ctx.auth.user?.email ?? null,
    /** Identifica la sesión para limitar intentos de marcación fallidos. */
    claveSesion: `u:${ctx.auth.user?.id ?? ctx.auth.user?.email ?? "anon"}`,
    /** Id del usuario en el schema, para `registrado_por`. */
    async usuarioId(): Promise<string | null> {
      const yo = await usuarioDelSchema({
        schema,
        empresaId,
        email: ctx.auth.user?.email,
        catalogId: ctx.auth.usuarioCatalogId ?? null,
      }).catch(() => null);
      return yo?.id ?? null;
    },
  } as const;
}

export function respuestaDeError(err: unknown, contexto: string) {
  if (err instanceof AsistenciaError) {
    return NextResponse.json(errorResponse(err.message), { status: err.status });
  }
  const e = err as { code?: string; message?: string };
  // Tablas todavía no creadas: el script 09 no se corrió.
  if (e?.code === "42P01" || e?.code === "42703") {
    return NextResponse.json(
      errorResponse("Faltan tablas de RRHH: correr los scripts de supabase/amasso (09 y 14)."),
      { status: 500 }
    );
  }
  console.error(`[rrhh] ${contexto}:`, e?.message ?? err);
  return NextResponse.json(errorResponse(e?.message ?? "Error inesperado."), { status: 500 });
}
