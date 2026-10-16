"use client";

import { useEffect, useState } from "react";
import type {
  CondicionPagoProveedor,
  EstadoProveedor,
  ProveedorCategoria,
} from "@/lib/proveedores/types";
import { createCategoriaProveedor, getCategoriasProveedor } from "@/lib/proveedores/storage";

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#4FAEB2]/40 focus:border-[#4FAEB2] bg-white text-sm";
const labelClass = "block text-sm font-medium text-slate-700 mb-1";

export interface ProveedorFormValues {
  nombre: string;
  nombre_comercial: string;
  razon_social: string;
  ruc: string;
  telefono: string;
  email: string;
  direccion: string;
  contacto: string;
  estado: EstadoProveedor;
  condicion_pago: CondicionPagoProveedor | "";
  plazo_pago_dias: string;
  moneda_preferida: "" | "GS" | "USD";
  observaciones: string;
  categoria_ids: string[];
}

export function emptyProveedorForm(): ProveedorFormValues {
  return {
    nombre: "",
    nombre_comercial: "",
    razon_social: "",
    ruc: "",
    telefono: "",
    email: "",
    direccion: "",
    contacto: "",
    estado: "activo",
    condicion_pago: "",
    plazo_pago_dias: "",
    moneda_preferida: "",
    observaciones: "",
    categoria_ids: [],
  };
}

export default function ProveedorForm({
  values,
  onChange,
  disabled,
}: {
  values: ProveedorFormValues;
  onChange: (next: ProveedorFormValues) => void;
  disabled?: boolean;
}) {
  function patch<K extends keyof ProveedorFormValues>(key: K, v: ProveedorFormValues[K]) {
    onChange({ ...values, [key]: v });
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelClass}>Razón social / Nombre del proveedor *</label>
          <input
            className={`${inputClass} uppercase`}
            value={values.nombre}
            onChange={(e) => patch("nombre", e.target.value)}
            placeholder="Ej: DISTRIBUIDORA EJEMPLO S.A."
            disabled={disabled}
            required
          />
          <p className="mt-1 text-xs text-slate-400">
            Se guarda en mayúsculas para unificar reportes.
          </p>
        </div>
        <div>
          <label className={labelClass}>RUC</label>
          <input
            className={`${inputClass} uppercase`}
            value={values.ruc}
            onChange={(e) => patch("ruc", e.target.value)}
            placeholder="Opcional"
            disabled={disabled}
          />
        </div>
        <div>
          <label className={labelClass}>Nombre comercial (opcional)</label>
          <input
            className={`${inputClass} uppercase`}
            value={values.nombre_comercial}
            onChange={(e) => patch("nombre_comercial", e.target.value)}
            placeholder="Si difiere del razón social"
            disabled={disabled}
          />
        </div>
        <div>
          <label className={labelClass}>Teléfono</label>
          <input
            className={inputClass}
            value={values.telefono}
            onChange={(e) => patch("telefono", e.target.value)}
            disabled={disabled}
          />
        </div>
        <div>
          <label className={labelClass}>Email</label>
          <input
            type="email"
            className={inputClass}
            value={values.email}
            // Sin transformar mientras se tipea: en un input type="email" el
            // navegador no deja restaurar la posición del cursor, así que
            // reescribir el valor en cada tecla lo manda al final y el texto
            // sale desordenado. Se normaliza al salir del campo.
            onChange={(e) => patch("email", e.target.value)}
            onBlur={(e) => patch("email", e.target.value.trim().toLowerCase())}
            disabled={disabled}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Dirección</label>
          <input
            className={`${inputClass} uppercase`}
            value={values.direccion}
            onChange={(e) => patch("direccion", e.target.value)}
            disabled={disabled}
          />
        </div>
        <div>
          <label className={labelClass}>Contacto principal</label>
          <input
            className={`${inputClass} uppercase`}
            value={values.contacto}
            onChange={(e) => patch("contacto", e.target.value)}
            disabled={disabled}
          />
        </div>
        <div>
          <label className={labelClass}>Estado</label>
          <select
            className={inputClass}
            value={values.estado}
            onChange={(e) => patch("estado", e.target.value as EstadoProveedor)}
            disabled={disabled}
          >
            <option value="activo">Activo</option>
            <option value="inactivo">Inactivo</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Condición de pago habitual</label>
          <select
            className={inputClass}
            value={values.condicion_pago}
            onChange={(e) => patch("condicion_pago", e.target.value as ProveedorFormValues["condicion_pago"])}
            disabled={disabled}
          >
            <option value="">— Sin definir —</option>
            <option value="contado">Contado</option>
            <option value="credito">Crédito</option>
            <option value="mixto">Mixto</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Plazo (días)</label>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={values.plazo_pago_dias}
            onChange={(e) => patch("plazo_pago_dias", e.target.value)}
            disabled={disabled}
          />
        </div>
        <div>
          <label className={labelClass}>Moneda preferida</label>
          <select
            className={inputClass}
            value={values.moneda_preferida}
            onChange={(e) => patch("moneda_preferida", e.target.value as ProveedorFormValues["moneda_preferida"])}
            disabled={disabled}
          >
            <option value="">—</option>
            <option value="GS">Guaraníes (GS)</option>
            <option value="USD">Dólares (USD)</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Categorías</label>
          <CategoriasSelector
            value={values.categoria_ids}
            onChange={(ids) => patch("categoria_ids", ids)}
            disabled={disabled}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Observaciones</label>
          <textarea
            className={`${inputClass} min-h-[88px]`}
            value={values.observaciones}
            onChange={(e) => patch("observaciones", e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>

    </div>
  );
}

/**
 * Elegir categorías del proveedor y crear una nueva sin salir del formulario.
 * La nueva queda marcada. La lista completa se administra en Proveedores › Categorías.
 */
function CategoriasSelector({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [categorias, setCategorias] = useState<ProveedorCategoria[]>([]);
  const [cargando, setCargando] = useState(true);
  const [nueva, setNueva] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void getCategoriasProveedor().then((cs) => {
      if (vivo) {
        setCategorias(cs);
        setCargando(false);
      }
    });
    return () => {
      vivo = false;
    };
  }, []);

  function alternar(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }

  async function crear() {
    const nombre = (nueva ?? "").trim();
    if (!nombre) {
      setError("Escribí el nombre de la categoría.");
      return;
    }
    setGuardando(true);
    setError(null);
    const r = await createCategoriaProveedor({ nombre });
    setGuardando(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setCategorias((cs) => [...cs, r.categoria].sort((a, b) => a.nombre.localeCompare(b.nombre)));
    onChange([...value, r.categoria.id]);
    setNueva(null);
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap gap-2">
        {cargando ? (
          <span className="text-xs text-slate-400">Cargando categorías…</span>
        ) : categorias.length === 0 ? (
          <span className="text-xs text-slate-400">Todavía no hay categorías.</span>
        ) : (
          categorias.map((c) => {
            const on = value.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                onClick={() => alternar(c.id)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  on
                    ? "border-[#4FAEB2] bg-[#4FAEB2] text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-[#4FAEB2] hover:text-[#3F8E91]"
                }`}
              >
                {on ? "✓ " : ""}
                {c.nombre}
              </button>
            );
          })
        )}
        {nueva === null && !disabled ? (
          <button
            type="button"
            onClick={() => {
              setNueva("");
              setError(null);
            }}
            className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/5"
          >
            + Nueva categoría
          </button>
        ) : null}
      </div>
      {nueva !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            autoFocus
            className={`${inputClass} max-w-xs uppercase`}
            value={nueva}
            onChange={(e) => setNueva(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void crear();
              }
              if (e.key === "Escape") setNueva(null);
            }}
            placeholder="Ej: HARINAS"
            disabled={guardando}
          />
          <button
            type="button"
            onClick={() => void crear()}
            disabled={guardando}
            className="rounded-lg bg-[#4FAEB2] px-3 py-2 text-xs font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-60"
          >
            {guardando ? "Creando…" : "Crear y marcar"}
          </button>
          <button
            type="button"
            onClick={() => setNueva(null)}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100"
          >
            Cancelar
          </button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
