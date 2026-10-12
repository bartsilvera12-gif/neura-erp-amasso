"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import { formatCantidad } from "@/lib/inventario/unidades";

/**
 * Inventario › Transferencias entre depósitos (Fábrica ⇄ Punto de venta).
 * El total de la empresa no cambia: la mercadería cambia de lugar.
 */

type Ubicacion = { id: string; nombre: string; tipo: string };
type StockLinea = { producto_id: string; producto_nombre: string; sku: string | null; unidad_medida: string; stock_actual: number };
type Linea = { producto_id: string; cantidad: string };
type Transferencia = {
  referencia: string;
  fecha: string;
  origen: string | null;
  destino: string | null;
  usuario: string | null;
  lineas: { producto: string; cantidad: number }[];
};

const INPUT =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";
const LABEL = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500";

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T };
  if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
  return j.data as T;
}

const etiquetaUbi = (u: Ubicacion) => `${u.nombre}${u.tipo === "salon" ? " (Punto de venta)" : ""}`;
const num = (s: string) => parseFloat(s.replace(",", ".")) || 0;

export default function TransferenciasPage() {
  const [ubicaciones, setUbicaciones] = useState<Ubicacion[]>([]);
  const [origenId, setOrigenId] = useState("");
  const [destinoId, setDestinoId] = useState("");
  const [stock, setStock] = useState<StockLinea[]>([]);
  const [lineas, setLineas] = useState<Linea[]>([{ producto_id: "", cantidad: "" }]);
  const [observacion, setObservacion] = useState("");
  const [historial, setHistorial] = useState<Transferencia[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargarHistorial = useCallback(async () => {
    try {
      const d = await pedir<{ transferencias: Transferencia[] }>("/api/inventario/transferencias");
      setHistorial(d.transferencias);
    } catch {
      /* el historial es secundario: si falla, la pantalla sigue sirviendo para transferir */
    }
  }, []);

  useEffect(() => {
    pedir<{ ubicaciones: Ubicacion[] }>("/api/inventario/ubicaciones")
      .then((d) => {
        const deps = d.ubicaciones.filter((u) => u.tipo !== "camion");
        setUbicaciones(deps);
        // Lo más común: de la fábrica al punto de venta.
        const pdv = deps.find((u) => u.tipo === "salon");
        const fab = deps.find((u) => u.tipo !== "salon");
        if (fab) setOrigenId(fab.id);
        if (pdv) setDestinoId(pdv.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void cargarHistorial();
  }, [cargarHistorial]);

  useEffect(() => {
    if (!origenId) return setStock([]);
    pedir<{ stock: StockLinea[] }>(`/api/inventario/ubicaciones/${origenId}/stock`)
      .then((d) => setStock(d.stock.filter((s) => Number(s.stock_actual) > 0)))
      .catch(() => setStock([]));
    setLineas([{ producto_id: "", cantidad: "" }]);
  }, [origenId]);

  const stockDe = useMemo(() => new Map(stock.map((s) => [s.producto_id, s])), [stock]);

  const errorLinea = (l: Linea): string | null => {
    if (!l.producto_id || !l.cantidad) return null;
    const s = stockDe.get(l.producto_id);
    const c = num(l.cantidad);
    if (c <= 0) return "Cantidad inválida";
    if (s && c > Number(s.stock_actual) + 1e-9) return `Máximo ${formatCantidad(Number(s.stock_actual), s.unidad_medida)}`;
    return null;
  };

  const validas = lineas.filter((l) => l.producto_id && num(l.cantidad) > 0);
  const puedeGuardar =
    !guardando && origenId && destinoId && origenId !== destinoId && validas.length > 0 && lineas.every((l) => !errorLinea(l));

  async function guardar() {
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const r = await pedir<{ referencia: string; items: number }>("/api/inventario/transferencias", {
        method: "POST",
        body: JSON.stringify({
          origen_id: origenId,
          destino_id: destinoId,
          observacion,
          items: validas.map((l) => ({ producto_id: l.producto_id, cantidad: num(l.cantidad) })),
        }),
      });
      setAviso(`Transferencia ${r.referencia} registrada (${r.items} producto${r.items === 1 ? "" : "s"}).`);
      setLineas([{ producto_id: "", cantidad: "" }]);
      setObservacion("");
      const d = await pedir<{ stock: StockLinea[] }>(`/api/inventario/ubicaciones/${origenId}/stock`);
      setStock(d.stock.filter((s) => Number(s.stock_actual) > 0));
      void cargarHistorial();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-6 pb-10">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Inventario</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Transferencias entre depósitos</h1>
        <p className="mt-1 text-sm text-slate-500">
          Mové mercadería de un depósito a otro, por ejemplo de Fábrica al Punto de venta. El stock total no cambia.
        </p>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="t-origen">Desde</label>
            <select id="t-origen" className={INPUT} value={origenId} onChange={(e) => setOrigenId(e.target.value)}>
              <option value="">Elegir depósito…</option>
              {ubicaciones.map((u) => (
                <option key={u.id} value={u.id}>{etiquetaUbi(u)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="t-destino">Hacia</label>
            <select id="t-destino" className={INPUT} value={destinoId} onChange={(e) => setDestinoId(e.target.value)}>
              <option value="">Elegir depósito…</option>
              {ubicaciones.filter((u) => u.id !== origenId).map((u) => (
                <option key={u.id} value={u.id}>{etiquetaUbi(u)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <p className={LABEL}>Productos</p>
          {origenId && stock.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">Ese depósito no tiene stock para transferir.</p>
          ) : null}
          {lineas.map((l, i) => {
            const s = stockDe.get(l.producto_id);
            const err = errorLinea(l);
            return (
              <div key={i} className="flex flex-wrap items-start gap-2">
                <select
                  className={`${INPUT} min-w-[14rem] flex-1`}
                  value={l.producto_id}
                  onChange={(e) => setLineas((ls) => ls.map((x, j) => (j === i ? { ...x, producto_id: e.target.value } : x)))}
                  aria-label={`Producto ${i + 1}`}
                >
                  <option value="">Elegir producto…</option>
                  {stock.map((p) => (
                    <option key={p.producto_id} value={p.producto_id}>
                      {p.producto_nombre} — hay {formatCantidad(Number(p.stock_actual), p.unidad_medida)} {p.unidad_medida}
                    </option>
                  ))}
                </select>
                <div className="w-36">
                  <input
                    inputMode="decimal"
                    className={`${INPUT} ${err ? "border-rose-400 bg-rose-50 text-rose-700" : ""}`}
                    placeholder={s ? `Máx ${formatCantidad(Number(s.stock_actual), s.unidad_medida)}` : "Cantidad"}
                    value={l.cantidad}
                    onChange={(e) =>
                      setLineas((ls) => ls.map((x, j) => (j === i ? { ...x, cantidad: e.target.value.replace(/[^0-9.,]/g, "") } : x)))
                    }
                    aria-label={`Cantidad ${i + 1}`}
                  />
                  {err ? <p className="mt-1 text-[11px] text-rose-600">{err}</p> : null}
                </div>
                {s ? <span className="pt-2 text-xs text-slate-400">{s.unidad_medida}</span> : null}
                {lineas.length > 1 ? (
                  <button
                    type="button"
                    className="rounded-lg px-2 py-2 text-xs text-rose-600 hover:bg-rose-50"
                    onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}
                  >
                    Quitar
                  </button>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            className="text-sm font-semibold text-[#3F8E91] hover:underline"
            onClick={() => setLineas((ls) => [...ls, { producto_id: "", cantidad: "" }])}
          >
            + Agregar otro producto
          </button>
        </div>

        <div className="mt-4">
          <label className={LABEL} htmlFor="t-obs">Observación (opcional)</label>
          <input id="t-obs" className={INPUT} value={observacion} maxLength={200} onChange={(e) => setObservacion(e.target.value)} />
        </div>

        {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        {aviso ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{aviso}</p> : null}

        <button
          type="button"
          disabled={!puedeGuardar}
          onClick={() => void guardar()}
          className="mt-4 rounded-xl bg-[#3F8E91] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#357a7d] disabled:opacity-50"
        >
          {guardando ? "Transfiriendo…" : "Transferir"}
        </button>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Últimas transferencias</h2>
        {historial.length === 0 ? (
          <p className="text-sm text-slate-400">Todavía no hay transferencias.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {historial.map((t) => (
              <li key={t.referencia} className="py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-xs text-slate-500">{t.referencia}</span>
                  <span className="font-medium text-slate-800">
                    {t.origen ?? "?"} → {t.destino ?? "?"}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(t.fecha).toLocaleString("es-PY", { dateStyle: "short", timeStyle: "short" })}
                    {t.usuario ? ` · ${t.usuario}` : ""}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t.lineas.map((l) => `${l.producto} × ${l.cantidad.toLocaleString("es-PY")}`).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
