import AccesoDenegado from "@/components/auth/AccesoDenegado";
import { accesoModuloServidor } from "@/lib/auth/solo-admin-servidor";

/**
 * Gestión Clientes: quién entra lo define RRHH › Configuración (por defecto, solo administradores; RF-05). Este layout
 * cubre la dirección escrita a mano y el refresh; ocultar el menú no alcanzaba.
 */
export const dynamic = "force-dynamic";

export default async function GestionClientesLayout({ children }: { children: React.ReactNode }) {
  const acceso = await accesoModuloServidor("gestion_clientes");
  if (!acceso.ok) return <AccesoDenegado modulo="Gestión Clientes" sinSesion={acceso.motivo === "sin_sesion"} />;
  return <>{children}</>;
}
