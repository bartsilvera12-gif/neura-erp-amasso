/**
 * Ítems que no se muestran en el menú pero cuyas rutas siguen abiertas.
 *
 * Ocultar acá NO es un permiso: quien escriba la URL entra igual, y las
 * pantallas siguen funcionando. Es sólo para sacar del menú lo que la
 * operación diaria no usa, sin romper los links internos que apuntan ahí.
 * Si hace falta cerrar el acceso de verdad, eso va por módulos/permisos.
 */

/**
 * `MenuItem.key` del Sidebar.
 *
 * `configuracion` estaba acá y se sacó: el admin de Amasso necesita entrar a
 * Plan de cuentas, Bancos y Depósitos desde el menú. El link de Bancos apunta
 * a `/configuracion/bancos`, que es una pantalla hija — no servía para llegar
 * al panel de Configuración.
 */
// Agenda y Cobranzas: ocultos a pedido de Amasso (requerimientos, oct-2026).
// No venden a crédito por ahora, así que Cobranzas no tiene uso.
// Recetas volvió al menú como "Formulaciones e insumos" (mismo documento).
// Bancos y Gestión Clientes ya no están acá: quién los ve lo define
// RRHH › Configuración (ver `MODULOS_CONFIGURABLES` y el Sidebar).
export const ITEMS_OCULTOS_EN_MENU: ReadonlySet<string> = new Set<string>([
  "agenda",
  "cobranzas",
]);

/**
 * Ítems y rutas del menú cuyo acceso se configura en RRHH › Configuración
 * (nadie / solo administradores / todos). Mientras no se sabe la
 * configuración, se ocultan.
 */
export const MODULOS_CONFIGURABLES: Record<string, "bancos" | "gestion_clientes"> = {
  bancos: "bancos",
  "gestion-clientes": "gestion_clientes",
  "/configuracion/bancos": "bancos",
  "/gestion-clientes": "gestion_clientes",
};

/**
 * Prefijos de ruta que no se ofrecen en la navegación mobile.
 * Configuración sigue fuera del celular: es trabajo de escritorio del admin,
 * no del asesor en la calle. La ruta igual responde si alguien la escribe.
 */
export const RUTAS_OCULTAS_EN_NAV: readonly string[] = ["/configuracion", "/dashboard/recetas"];

export function estaOcultoEnMenu(key: string): boolean {
  return ITEMS_OCULTOS_EN_MENU.has(key);
}

export function rutaOcultaEnNav(href: string): boolean {
  return RUTAS_OCULTAS_EN_NAV.some((r) => href === r || href.startsWith(r + "/"));
}
