import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveUsuarioErpFromAuthUser } from "@/lib/auth/resolve-usuario-erp";
import { esRolAdminEmpresaOGlobal } from "@/lib/auth/rol-empresa";

/**
 * Puerta "solo administradores" para páginas y layouts (servidor, cookies).
 *
 * Ocultar un ítem del menú no impide entrar escribiendo la dirección. Esto sí:
 * corre en el servidor en cada request, antes de mostrar la pantalla. Se usa
 * para Gestión Clientes y Bancos (especificación de Amasso, RF-05). Las APIs
 * de esos módulos repiten el chequeo por su cuenta.
 */
export async function esAdminServidor(): Promise<{ ok: boolean; motivo: "sin_sesion" | "sin_permiso" | null }> {
  try {
    const sb = await createSupabaseServerClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return { ok: false, motivo: "sin_sesion" };
    const usuario = await resolveUsuarioErpFromAuthUser(createServiceRoleClient(), user as never);
    if (!usuario?.id) return { ok: false, motivo: "sin_permiso" };
    return esRolAdminEmpresaOGlobal(usuario.rol) ? { ok: true, motivo: null } : { ok: false, motivo: "sin_permiso" };
  } catch {
    // Ante un error se niega: nunca se abre por las dudas.
    return { ok: false, motivo: "sin_permiso" };
  }
}
