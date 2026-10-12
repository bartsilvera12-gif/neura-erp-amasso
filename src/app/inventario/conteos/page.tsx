"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import { useIsAdmin } from "@/lib/auth/use-is-admin";
import { formatCantidad } from "@/lib/inventario/unidades";
import { CLASE_INFO, esClaseProducto } from "@/lib/inventario/clases";

/**
 * Inventario › Conteo físico. Se abre un conteo por depósito (una vez por mes),
 * se carga lo contado y, al cerrarlo, el sistema ajusta las diferencias y avisa
 * qué quedó por debajo del stock mínimo. Cerrar lo hace un administrador.
 */

type Conteo = {
  id: string;
  ubicacion_nombre: string;
  fecha: string;
  estado: "borrador" | "cerrado";
  items_total: number;
  items_contados: number;
  items_con_diferencia: number;
};
type Item = {
  id: string;
  producto_nombre: string;
  sku: string | null;
  unidad_medida: string;
  clase_producto: string;
  stock_minimo: number;
  cantidad_sistema: number;
  cantidad_contada: number | null;
  motivo: string | null;
};
type Cierre = { ajustes: number; bajo_minimo: { producto: string; cantidad: number; minimo: number; unidad: string; clase: string }[] };

const INPUT =
  "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 disabled:bg-slate-50";

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T };
  if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
  return j.data as T;
}

const claseCorta = (c: string) => (esClaseProducto(c) ? CLASE_INFO[c].corta : c);
const aNum = (s: string): number | null => (s.trim() === "" ? null : parseFloat(s.replace(",", ".")));

export default function ConteosPage() {
  const { isAdmin } = useIsAdmin();
  const [conteos, setConteos] = useState<Conteo[]>([]);
  const [depositos, setDepositos] = useState<{ id: string; nombre: string; tipo: string }[]>([]);
  const [nuevoDeposito, setNuevoDeposito] = useState("");
  const [abiertoId, setAbiertoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const d = await pedir<{ conteos: Conteo[] }>("/api/inventario/conteos");
      setConteos(d.conteos);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void cargar();
    pedir<{ ubicaciones: { id: string; nombre: string; tipo: string }[] }>("/api/inventario/ubicaciones")
      .then((d) => setDepositos(d.ubicaciones.filter((u) => u.tipo !== "camion")))
      .catch(() => null);
  }, [cargar]);

  async function abrir() {
    setError(null);
    try {
      const d = await pedir<{ id: string }>("/api/inventario/conteos", {
        method: "POST",
        body: JSON.stringify({ ubicacion_id: nuevoDeposito }),
      });
      await cargar();
      setAbiertoId(d.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (abiertoId) {
    return <DetalleConteo id={abiertoId} puedeCerrar={isAdmin} onVolver={() => { setAbiertoId(null); void cargar(); }} />;
  }

  return (
    <div className="space-y-6 pb-10">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Inventario</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Conteo físico</h1>
        <p className="mt-1 text-sm text-slate-500">
          Una vez por mes, por depósito. Al cerrar el conteo se ajustan las diferencias, con su motivo, y se avisa qué quedó
          por debajo del stock mínimo.
        </p>
      </div>

      <section className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500" htmlFor="c-dep">
            Depósito a contar
          </label>
          <select id="c-dep" className={`${INPUT} min-w-[16rem]`} value={nuevoDeposito} onChange={(e) => setNuevoDeposito(e.target.value)}>
            <option value="">Elegir…</option>
            {depositos.map((d) => (
              <option key={d.id} value={d.id}>{d.nombre}{d.tipo === "salon" ? " (Punto de venta)" : ""}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={!nuevoDeposito}
          onClick={() => void abrir()}
          className="rounded-xl bg-[#3F8E91] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Empezar conteo
        </button>
        {error ? <p className="w-full rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            <tr>
              <th className="py-2">Fecha</th>
              <th className="py-2">Depósito</th>
              <th className="py-2">Estado</th>
              <th className="py-2 text-right">Contados</th>
              <th className="py-2 text-right">Con diferencia</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {conteos.length === 0 ? (
              <tr><td colSpan={6} className="py-6 text-center text-slate-400">Todavía no hay conteos.</td></tr>
            ) : conteos.map((c) => (
              <tr key={c.id}>
                <td className="py-2.5 tabular-nums">{new Date(`${c.fecha}T12:00:00`).toLocaleDateString("es-PY")}</td>
                <td className="py-2.5">{c.ubicacion_nombre}</td>
                <td className="py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${c.estado === "cerrado" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-800"}`}>
                    {c.estado === "cerrado" ? "Cerrado" : "En curso"}
                  </span>
                </td>
                <td className="py-2.5 text-right tabular-nums">{c.items_contados} / {c.items_total}</td>
                <td className="py-2.5 text-right tabular-nums">{c.items_con_diferencia}</td>
                <td className="py-2.5 text-right">
                  <button type="button" className="text-sm font-semibold text-[#3F8E91] hover:underline" onClick={() => setAbiertoId(c.id)}>
                    {c.estado === "borrador" ? "Seguir contando" : "Ver"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function DetalleConteo({ id, puedeCerrar, onVolver }: { id: string; puedeCerrar: boolean; onVolver: () => void }) {
  const [conteo, setConteo] = useState<Conteo | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [borrador, setBorrador] = useState<Record<string, { contada: string; motivo: string }>>({});
  const [busqueda, setBusqueda] = useState("");
  const [soloDif, setSoloDif] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [cierre, setCierre] = useState<Cierre | null>(null);

  const cargar = useCallback(async () => {
    const d = await pedir<{ conteo: Conteo; items: Item[] }>(`/api/inventario/conteos/${id}`);
    setConteo(d.conteo);
    setItems(d.items);
    setBorrador(
      Object.fromEntries(
        d.items.map((i) => [i.id, { contada: i.cantidad_contada == null ? "" : String(i.cantidad_contada), motivo: i.motivo ?? "" }])
      )
    );
  }, [id]);

  useEffect(() => {
    cargar().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [cargar]);

  const cerrado = conteo?.estado === "cerrado";
  const dif = (i: Item) => {
    const c = aNum(borrador[i.id]?.contada ?? "");
    return c == null || Number.isNaN(c) ? null : Math.round((c - i.cantidad_sistema) * 1e6) / 1e6;
  };

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return items.filter((i) => {
      if (soloDif && !dif(i)) return false;
      return !q || i.producto_nombre.toLowerCase().includes(q) || (i.sku ?? "").toLowerCase().includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, busqueda, soloDif, borrador]);

  async function guardar(): Promise<boolean> {
    setGuardando(true);
    setError(null);
    try {
      await pedir(`/api/inventario/conteos/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          items: items.map((i) => ({
            id: i.id,
            cantidad_contada: aNum(borrador[i.id]?.contada ?? ""),
            motivo: borrador[i.id]?.motivo ?? null,
          })),
        }),
      });
      await cargar();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setGuardando(false);
    }
  }

  async function cerrar() {
    if (!(await guardar())) return;
    if (!window.confirm("Se ajustará el stock de este depósito con lo contado. ¿Cerrar el conteo?")) return;
    setGuardando(true);
    try {
      const r = await pedir<Cierre>(`/api/inventario/conteos/${id}/cerrar`, { method: "POST" });
      setCierre(r);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-5 pb-10">
      <button type="button" className="text-sm text-[#3F8E91] hover:underline" onClick={onVolver}>← Volver a los conteos</button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Conteo de {conteo?.ubicacion_nombre ?? "…"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {cerrado
            ? "Conteo cerrado: las diferencias ya se ajustaron."
            : "Cargá lo que contaste. Lo que dejes vacío no se ajusta. Toda diferencia necesita un motivo."}
        </p>
      </div>

      {cierre ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-semibold">Conteo cerrado: {cierre.ajustes} ajuste{cierre.ajustes === 1 ? "" : "s"} de stock.</p>
          {cierre.bajo_minimo.length > 0 ? (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
              <p className="font-semibold">Quedaron por debajo del stock mínimo:</p>
              <ul className="mt-1 list-disc pl-5">
                {cierre.bajo_minimo.map((b) => (
                  <li key={b.producto}>
                    {b.producto} ({claseCorta(b.clase)}): hay {formatCantidad(b.cantidad, b.unidad)} {b.unidad}, mínimo {formatCantidad(b.minimo, b.unidad)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-1">Nada quedó por debajo del stock mínimo.</p>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <input className={`${INPUT} min-w-[16rem]`} placeholder="Buscar producto…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={soloDif} onChange={(e) => setSoloDif(e.target.checked)} /> Solo con diferencia
        </label>
      </div>

      {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            <tr>
              <th className="px-3 py-2.5">Producto</th>
              <th className="px-3 py-2.5 text-right">Sistema</th>
              <th className="px-3 py-2.5">Contado</th>
              <th className="px-3 py-2.5 text-right">Diferencia</th>
              <th className="px-3 py-2.5">Motivo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibles.map((i) => {
              const d = dif(i);
              const faltaMotivo = !!d && !(borrador[i.id]?.motivo ?? "").trim();
              return (
                <tr key={i.id}>
                  <td className="px-3 py-2">
                    <span className="block font-medium text-slate-800">{i.producto_nombre}</span>
                    <span className="text-xs text-slate-400">{claseCorta(i.clase_producto)}{i.sku ? ` · ${i.sku}` : ""}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {formatCantidad(i.cantidad_sistema, i.unidad_medida)} {i.unidad_medida}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      inputMode="decimal"
                      className={`${INPUT} w-28`}
                      disabled={cerrado}
                      value={borrador[i.id]?.contada ?? ""}
                      onChange={(e) =>
                        setBorrador((b) => ({ ...b, [i.id]: { ...b[i.id], contada: e.target.value.replace(/[^0-9.,]/g, "") } }))
                      }
                      aria-label={`Contado de ${i.producto_nombre}`}
                    />
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${!d ? "text-slate-300" : d < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {d == null ? "—" : d === 0 ? "0" : `${d > 0 ? "+" : ""}${formatCantidad(d, i.unidad_medida)}`}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className={`${INPUT} w-full min-w-[12rem] ${faltaMotivo && !cerrado ? "border-amber-400 bg-amber-50" : ""}`}
                      disabled={cerrado || !d}
                      placeholder={d ? "Ej: rotura, vencido, error de carga" : ""}
                      value={borrador[i.id]?.motivo ?? ""}
                      onChange={(e) => setBorrador((b) => ({ ...b, [i.id]: { ...b[i.id], motivo: e.target.value } }))}
                      aria-label={`Motivo de ${i.producto_nombre}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!cerrado ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={guardando} onClick={() => void guardar()} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">
            {guardando ? "Guardando…" : "Guardar avance"}
          </button>
          {puedeCerrar ? (
            <button type="button" disabled={guardando} onClick={() => void cerrar()} className="rounded-xl bg-[#3F8E91] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Cerrar conteo y ajustar stock
            </button>
          ) : (
            <span className="self-center text-xs text-slate-500">Cerrar y ajustar lo hace un administrador.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
