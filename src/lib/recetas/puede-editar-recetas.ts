import { isErpRolAdministrador, isErpRolSupervisor } from "@/lib/usuarios/erp-rol-normalize";

/**
 * Editar el recetario (crear / editar / eliminar recetas e insumos): solo admin
 * y supervisor. FABRICAR desde una receta lo puede hacer cualquier rol — es una
 * operación de planta, no de configuración.
 *
 * Vive en un módulo sin imports de servidor a propósito: lo usan tanto el guard
 * de las rutas (`require-edicion-recetas.ts`) como la UI, que es cliente y no
 * puede arrastrar `next/server`.
 */
export function puedeEditarRecetas(rol: string | null | undefined): boolean {
  return isErpRolAdministrador(rol) || isErpRolSupervisor(rol);
}
