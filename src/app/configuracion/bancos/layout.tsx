import AccesoDenegado from "@/components/auth/AccesoDenegado";
import { accesoModuloServidor } from "@/lib/auth/solo-admin-servidor";

/**
 * Bancos: quién entra lo define RRHH › Configuración (por defecto, solo administradores; RF-05). Este layout
 * cubre la dirección escrita a mano y el refresh; ocultar el menú no alcanzaba.
 */
export const dynamic = "force-dynamic";

export default async function BancosLayout({ children }: { children: React.ReactNode }) {
  const acceso = await accesoModuloServidor("bancos");
  if (!acceso.ok) return <AccesoDenegado modulo="Bancos" sinSesion={acceso.motivo === "sin_sesion"} />;
  return <>{children}</>;
}
