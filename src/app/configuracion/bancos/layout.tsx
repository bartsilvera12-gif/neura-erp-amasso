import AccesoDenegado from "@/components/auth/AccesoDenegado";
import { esAdminServidor } from "@/lib/auth/solo-admin-servidor";

/**
 * Bancos: solo administradores (especificación de Amasso, RF-05). Este layout
 * cubre la dirección escrita a mano y el refresh; ocultar el menú no alcanzaba.
 */
export const dynamic = "force-dynamic";

export default async function BancosLayout({ children }: { children: React.ReactNode }) {
  const acceso = await esAdminServidor();
  if (!acceso.ok) return <AccesoDenegado modulo="Bancos" sinSesion={acceso.motivo === "sin_sesion"} />;
  return <>{children}</>;
}
