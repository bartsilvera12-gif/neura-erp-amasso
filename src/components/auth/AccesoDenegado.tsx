import Link from "next/link";
import { ShieldAlert } from "lucide-react";

export default function AccesoDenegado({ modulo, sinSesion }: { modulo: string; sinSesion?: boolean }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-20 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-500">
        <ShieldAlert className="h-6 w-6" aria-hidden />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-slate-900">Acceso denegado</h1>
      <p className="mt-1.5 text-sm text-slate-500">
        {sinSesion
          ? "Tu sesión expiró. Volvé a iniciar sesión."
          : `${modulo} está disponible solo para administradores.`}
      </p>
      <Link
        href="/"
        className="mt-5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 no-underline hover:bg-slate-50"
      >
        Volver al inicio
      </Link>
    </div>
  );
}
