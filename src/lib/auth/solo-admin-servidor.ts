import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveUsuarioErpFromAuthUser } from "@/lib/auth/resolve-usuario-erp";
import { esRolAdminEmpresaOGlobal } from "@/lib/auth/rol-empresa";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { leerConfig, puedeEntrar } from "@/lib/rrhh/config-pg";

/**
 * Puerta de Gestión Clientes y Bancos para páginas y layouts (servidor, cookies).
 *
 * Ocultar un ítem del menú no impide entrar escribiendo la dirección. Esto sí:
 * corre en el servidor en cada request, antes de mostrar la pantalla. Quién
 * entra lo define RRHH › Configuración (nadie / solo administradores / todos);
 * por defecto, solo administradores (especificación de Amasso, RF-05). Las APIs
 * de esos módulos repiten el chequeo por su cuenta.
 */
export async function accesoModuloServidor(
  modulo: "gestion_clientes" | "bancos"
): Promise<{ ok: boolean; motivo: "sin_sesion" | "sin_permiso" | null }> {
  try {
    const sb = await createSupabaseServerClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return { ok: false, motivo: "sin_sesion" };
    const usuario = await resolveUsuarioErpFromAuthUser(createServiceRoleClient(), user as never);
    if (!usuario?.id || !usuario.empresa_id) return { ok: false, motivo: "sin_permiso" };
    const cfg = await leerConfig(await fetchDataSchemaForEmpresaId(usuario.empresa_id), usuario.empresa_id);
    return puedeEntrar(cfg.modulos[modulo], esRolAdminEmpresaOGlobal(usuario.rol))
      ? { ok: true, motivo: null }
      : { ok: false, motivo: "sin_permiso" };
  } catch {
    // Ante un error se niega: nunca se abre por las dudas.
    return { ok: false, motivo: "sin_permiso" };
  }
}

/** Para las APIs: mismo criterio a partir de la empresa y el rol ya resueltos. */
export async function puedeUsarModulo(
  empresaId: string,
  rol: string | null | undefined,
  modulo: "gestion_clientes" | "bancos"
): Promise<boolean> {
  try {
    const cfg = await leerConfig(await fetchDataSchemaForEmpresaId(empresaId), empresaId);
    const r = String(rol ?? "").trim();
    return puedeEntrar(cfg.modulos[modulo], r === "super_admin" || esRolAdminEmpresaOGlobal(r));
  } catch {
    return false;
  }
}
