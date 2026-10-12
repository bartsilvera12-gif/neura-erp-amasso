"use client";

import { useState } from "react";
import { createProveedor, proveedorExiste } from "@/lib/proveedores/storage";
import type { Proveedor } from "@/lib/proveedores/types";

const INPUT =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40 bg-white";
const LABEL = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500";

/**
 * Alta rápida de proveedor sin salir de la pantalla (órdenes de compra).
 * Mismas reglas que en Compras: nombre y RUC obligatorios, RUC sin repetir.
 */
export default function NuevoProveedorInline({
  nombreInicial = "",
  onCreado,
  onCancelar,
}: {
  nombreInicial?: string;
  onCreado: (p: Proveedor) => void;
  onCancelar: () => void;
}) {
  const [f, setF] = useState({ nombre: nombreInicial.toUpperCase(), ruc: "", telefono: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    if (!f.nombre.trim() || !f.ruc.trim()) return;
    setGuardando(true);
    setError(null);
    try {
      const dup = await proveedorExiste(f.ruc);
      if (dup) {
        setError(`RUC ya registrado para "${dup.nombre}".`);
        return;
      }
      const r = await createProveedor({
        nombre: f.nombre.trim().toUpperCase(),
        ruc: f.ruc.trim(),
        telefono: f.telefono.trim(),
        email: f.email.trim().toLowerCase(),
        contacto: "",
        direccion: "",
        estado: "activo",
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onCreado(r.proveedor);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-[#4FAEB2]/40 bg-[#4FAEB2]/5 p-3">
      <p className="mb-2 text-sm font-semibold text-slate-700">Nuevo proveedor</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL}>Nombre / Razón social *</label>
          <input className={`${INPUT} uppercase`} value={f.nombre} onChange={(e) => setF((p) => ({ ...p, nombre: e.target.value.toUpperCase() }))} />
        </div>
        <div>
          <label className={LABEL}>RUC *</label>
          <input className={INPUT} value={f.ruc} placeholder="Ej: 80012345-1" onChange={(e) => setF((p) => ({ ...p, ruc: e.target.value }))} />
        </div>
        <div>
          <label className={LABEL}>Teléfono</label>
          <input className={INPUT} value={f.telefono} onChange={(e) => setF((p) => ({ ...p, telefono: e.target.value }))} />
        </div>
        <div>
          <label className={LABEL}>Email</label>
          <input className={INPUT} type="email" value={f.email} onChange={(e) => setF((p) => ({ ...p, email: e.target.value }))} />
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={guardando || !f.nombre.trim() || !f.ruc.trim()}
          onClick={() => void guardar()}
          className="rounded-lg bg-[#3F8E91] px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {guardando ? "Guardando…" : "Agregar proveedor"}
        </button>
        <button type="button" onClick={onCancelar} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600">
          Cancelar
        </button>
      </div>
    </div>
  );
}
