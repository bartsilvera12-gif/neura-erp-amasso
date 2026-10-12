"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import type { CajaVenta } from "@/shared/caja/useCajaVenta";

type Vendedor = { id: string; nombre: string; comision_pct: number | null };

/**
 * Vendedor de la venta. Lista los empleados con comisión cargada en RRHH: un
 * vendedor es el que cobra comisión. Si no hay ninguno, no se muestra.
 */
export default function SelectorVendedor({ caja }: { caja: CajaVenta }) {
  const [vendedores, setVendedores] = useState<Vendedor[]>([]);
  const [cargado, setCargado] = useState(false);

  useEffect(() => {
    let cancel = false;
    apiFetch("/api/rrhh/empleados")
      .then((r) => r.json())
      .then((j) => {
        if (cancel || !j?.success) return;
        setVendedores(((j.data?.empleados ?? []) as Vendedor[]).filter((e) => Number(e.comision_pct) > 0));
      })
      .catch(() => null)
      .finally(() => !cancel && setCargado(true));
    return () => {
      cancel = true;
    };
  }, []);

  // Sin vendedores cargados se explica cómo tenerlos, en vez de no mostrar nada:
  // QA buscaba el selector y no sabía que depende de la comisión del empleado.
  if (vendedores.length === 0) {
    if (!cargado) return null;
    return (
      <p className="text-xs text-slate-400">
        Para elegir vendedor en la venta, cargale un % de comisión en RRHH › Asistencia › Empleados.
      </p>
    );
  }
  return (
    <div>
      <label htmlFor="caja-vendedor" className="mb-1.5 block text-xs font-semibold uppercase tracking-widest text-slate-400">
        Vendedor
      </label>
      <select
        id="caja-vendedor"
        value={caja.vendedorId ?? ""}
        onChange={(e) => caja.setVendedorId(e.target.value || null)}
        className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
      >
        <option value="">Sin vendedor</option>
        {vendedores.map((v) => (
          <option key={v.id} value={v.id}>{v.nombre}</option>
        ))}
      </select>
    </div>
  );
}
