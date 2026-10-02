import { NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { puedeEditarRecetas } from "@/lib/recetas/puede-editar-recetas";
import type { UsuarioConEmpresaYRol } from "@/lib/middleware/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

export const MSG_RECETAS_SOLO_ADMIN_SUPERVISOR =
  "Solo un administrador o supervisor puede modificar el recetario. Podés fabricar desde una receta existente.";

type Ctx = { auth: UsuarioConEmpresaYRol; supabase: AppSupabaseClient };

/**
 * Guard de servidor para MUTAR el recetario.
 *
 * No usar para FABRICAR (`POST /api/producciones`). Tampoco para los GET, que
 * deben seguir abiertos: cualquier usuario necesita leer la receta para fabricar.
 *
 * Ocultar los botones en la UI no alcanza: sin este guard, un `usuario` puede
 * editar el recetario llamando la API directamente.
 */
export async function requireEdicionRecetas(
  request: Request
): Promise<{ ok: true; ctx: Ctx } | { ok: false; response: NextResponse }> {
  const ctx = await getTenantSupabaseFromAuthWithRol(request);
  if (!ctx) {
    return {
      ok: false,
      response: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }),
    };
  }
  if (!puedeEditarRecetas(ctx.auth.rol)) {
    return {
      ok: false,
      response: NextResponse.json(errorResponse(MSG_RECETAS_SOLO_ADMIN_SUPERVISOR), { status: 403 }),
    };
  }
  return { ok: true, ctx };
}
