"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import { Pantalla } from "@/components/rrhh/MarcarAsistencia";

/**
 * Terminal de marcación: una PC o tablet dedicada a que el personal marque
 * asistencia, con una sesión del ERP abierta. Muestra solo la pantalla de
 * marcar, a pantalla completa, y no se cierra. Se habilita en RRHH ›
 * Configuración › Dispositivos.
 */
export default function TerminalAsistenciaPage() {
  const [estado, setEstado] = useState<"cargando" | "activa" | "desactivada">("cargando");

  useEffect(() => {
    apiFetch("/api/rrhh/configuracion/publica", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: { dispositivos?: { terminal?: boolean } } } | null) =>
        setEstado(j?.data?.dispositivos?.terminal ? "activa" : "desactivada")
      )
      .catch(() => setEstado("desactivada"));
  }, []);

  if (estado === "cargando") return <p className="p-8 text-sm text-slate-400">Cargando…</p>;
  if (estado === "desactivada") {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-lg font-semibold text-slate-800">La terminal de marcación está desactivada</p>
        <p className="mt-2 text-sm text-slate-500">
          Un administrador la puede activar en RRHH › Configuración › Dispositivos.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm font-semibold text-[#3F8E91] hover:underline">
          Volver al inicio
        </Link>
      </div>
    );
  }
  return createPortal(<Pantalla terminal onCerrar={() => undefined} />, document.body);
}
