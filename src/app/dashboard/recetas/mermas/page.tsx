"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import { formatCantidad } from "@/lib/inventario/unidades";

/**
 * Formulaciones › Mermas y devoluciones. Dos destinos posibles:
 *  - Desecho: sale del stock.
 *  - Galleta molida: sale del stock y entra como producto intermedio.
 */

type Producto = { id: string; nombre: string; unidad_medida: string; clase_producto?: string };
type Ubicacion = { id: string; nombre: string; tipo: string };
type Merma = {
  id: string;
  fecha: string;
  producto_nombre: string;
  cantidad: number;
  origen: string;
  destino: "desecho" | "galleta_molida";
  destino_nombre: string | null;
  cantidad_destino: number | null;
  ubicacion_nombre: string | null;
  motivo: string | null;
  usuario_nombre: string | null;
};

const INPUT =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";
const LABEL = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500";
const ORIGEN: Record<string, string> = { merma: "Merma", devolucion: "Devolución", vencimiento: "Vencido", produccion: "Producción" };
const num = (s: string) => parseFloat(s.replace(",", ".")) || 0;

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T };
  if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
  return j.data as T;
}

const VACIO = { producto_id: "", cantidad: "", ubicacion_id: "", origen: "merma", destino: "desecho", producto_destino_id: "", cantidad_destino: "", motivo: "" };

export default function MermasPage() {
  const [productos, setProductos] = useState<Producto[]>([]);
  const [depositos, setDepositos] = useState<Ubicacion[]>([]);
  const [mermas, setMermas] = useState<Merma[]>([]);
  const [f, setF] = useState(VACIO);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setMermas((await pedir<{ mermas: Merma[] }>("/api/produccion/mermas")).mermas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void cargar();
    pedir<{ productos: Producto[] }>("/api/productos").then((d) => setProductos(d.productos)).catch(() => null);
    pedir<{ ubicaciones: Ubicacion[] }>("/api/inventario/ubicaciones")
      .then((d) => {
        const deps = d.ubicaciones.filter((u) => u.tipo !== "camion");
        setDepositos(deps);
        // Las devoluciones vuelven al punto de venta; por defecto se sugiere ese.
        const pdv = deps.find((u) => u.tipo === "salon") ?? deps[0];
        if (pdv) setF((x) => ({ ...x, ubicacion_id: x.ubicacion_id || pdv.id }));
      })
      .catch(() => null);
  }, [cargar]);

  const intermedios = productos.filter((p) => p.clase_producto === "intermedio");
  const prod = productos.find((p) => p.id === f.producto_id);

  async function guardar() {
    setOcupado(true);
    setError(null);
    setAviso(null);
    try {
      await pedir("/api/produccion/mermas", {
        method: "POST",
        body: JSON.stringify({
          ...f,
          cantidad: num(f.cantidad),
          cantidad_destino: f.destino === "galleta_molida" && f.cantidad_destino ? num(f.cantidad_destino) : null,
          producto_destino_id: f.destino === "galleta_molida" ? f.producto_destino_id || null : null,
        }),
      });
      setAviso("Registrado.");
      setF((x) => ({ ...VACIO, ubicacion_id: x.ubicacion_id }));
      void cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Formulaciones e insumos</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Mermas y devoluciones</h1>
          <p className="mt-1 text-sm text-slate-500">Dos destinos: desecho (sale del stock) o galleta molida (vuelve como intermedio).</p>
        </div>
        <Link href="/dashboard/recetas/produccion" className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700">
          Órdenes de producción
        </Link>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className={LABEL} htmlFor="m-prod">Producto</label>
            <select id="m-prod" className={INPUT} value={f.producto_id} onChange={(e) => setF((x) => ({ ...x, producto_id: e.target.value }))}>
              <option value="">Elegir…</option>
              {productos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="m-cant">Cantidad {prod ? `(${prod.unidad_medida})` : ""}</label>
            <input id="m-cant" inputMode="decimal" className={INPUT} value={f.cantidad} onChange={(e) => setF((x) => ({ ...x, cantidad: e.target.value.replace(/[^0-9.,]/g, "") }))} />
          </div>
          <div>
            <label className={LABEL} htmlFor="m-dep">Depósito</label>
            <select id="m-dep" className={INPUT} value={f.ubicacion_id} onChange={(e) => setF((x) => ({ ...x, ubicacion_id: e.target.value }))}>
              {depositos.map((d) => <option key={d.id} value={d.id}>{d.nombre}{d.tipo === "salon" ? " (Punto de venta)" : ""}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="m-orig">Qué es</label>
            <select id="m-orig" className={INPUT} value={f.origen} onChange={(e) => setF((x) => ({ ...x, origen: e.target.value }))}>
              <option value="merma">Merma</option>
              <option value="devolucion">Devolución</option>
              <option value="vencimiento">Vencido</option>
            </select>
          </div>
          <div>
            <label className={LABEL}>Destino</label>
            <div className="flex gap-2">
              {(["desecho", "galleta_molida"] as const).map((d) => (
                <button key={d} type="button" onClick={() => setF((x) => ({ ...x, destino: d }))}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${f.destino === d ? "border-[#4FAEB2] bg-[#4FAEB2]/10 font-semibold" : "border-slate-200"}`}>
                  {d === "desecho" ? "Desecho" : "Galleta molida"}
                </button>
              ))}
            </div>
          </div>
          {f.destino === "galleta_molida" ? (
            <>
              <div>
                <label className={LABEL} htmlFor="m-gal">Entra como</label>
                <select id="m-gal" className={INPUT} value={f.producto_destino_id} onChange={(e) => setF((x) => ({ ...x, producto_destino_id: e.target.value }))}>
                  <option value="">Elegir intermedio…</option>
                  {intermedios.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="m-galc">Cantidad que entra</label>
                <input id="m-galc" inputMode="decimal" className={INPUT} placeholder={f.cantidad || "Igual a la merma"} value={f.cantidad_destino}
                  onChange={(e) => setF((x) => ({ ...x, cantidad_destino: e.target.value.replace(/[^0-9.,]/g, "") }))} />
              </div>
            </>
          ) : null}
          <div className="sm:col-span-2 lg:col-span-4">
            <label className={LABEL} htmlFor="m-mot">Motivo (opcional)</label>
            <input id="m-mot" className={INPUT} value={f.motivo} onChange={(e) => setF((x) => ({ ...x, motivo: e.target.value }))} />
          </div>
        </div>
        {f.destino === "galleta_molida" && intermedios.length === 0 ? (
          <p className="mt-2 text-xs text-amber-700">No hay productos de clase Intermedio: cargá primero la galleta molida en Inventario.</p>
        ) : null}
        {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        {aviso ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{aviso}</p> : null}
        <button type="button" disabled={ocupado || !f.producto_id || num(f.cantidad) <= 0 || !f.ubicacion_id || (f.destino === "galleta_molida" && !f.producto_destino_id)}
          onClick={() => void guardar()} className="mt-4 rounded-xl bg-[#3F8E91] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {ocupado ? "Guardando…" : "Registrar"}
        </button>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Últimos registros</h2>
        {mermas.length === 0 ? (
          <p className="text-sm text-slate-400">Todavía no hay mermas registradas.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                <tr><th className="px-3 py-2 first:pl-0">Fecha</th><th className="px-3 py-2 first:pl-0">Producto</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 first:pl-0">Qué</th><th className="px-3 py-2 first:pl-0">Destino</th><th className="px-3 py-2 first:pl-0">Depósito</th><th className="px-3 py-2 first:pl-0">Quién</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {mermas.map((m) => (
                  <tr key={m.id}>
                    <td className="py-2 pl-0 pr-3 text-xs tabular-nums whitespace-nowrap">{new Date(m.fecha).toLocaleString("es-PY", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td className="px-3 py-2">{m.producto_nombre}{m.motivo ? <span className="block text-xs text-slate-400">{m.motivo}</span> : null}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatCantidad(m.cantidad, "")}</td>
                    <td className="px-3 py-2 text-xs">{ORIGEN[m.origen] ?? m.origen}</td>
                    <td className="px-3 py-2 text-xs">
                      {m.destino === "desecho" ? "Desecho" : `Galleta molida → ${m.destino_nombre ?? "?"}${m.cantidad_destino ? ` (${formatCantidad(m.cantidad_destino, "")})` : ""}`}
                    </td>
                    <td className="px-3 py-2 text-xs">{m.ubicacion_nombre ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{m.usuario_nombre ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
