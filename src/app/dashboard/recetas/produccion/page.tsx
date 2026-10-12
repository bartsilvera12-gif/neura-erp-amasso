"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import { formatCantidad } from "@/lib/inventario/unidades";

/**
 * Formulaciones › Órdenes de producción.
 *
 * Planificada → En proceso → Finalizada. Al crear la orden se ve la materia
 * prima necesaria y si alcanza en el depósito; al finalizar se carga lo que
 * salió de verdad y la merma, y recién ahí se mueve el stock (con lote y
 * vencimiento).
 */

type Estado = "planificada" | "en_proceso" | "finalizada" | "cancelada";
type Orden = {
  id: string;
  numero: string | null;
  estado: Estado;
  producto_nombre: string;
  unidad: string | null;
  cantidad_planificada: number | null;
  cantidad_fabricada: number;
  merma_cantidad: number;
  lote: string | null;
  fecha_vencimiento: string | null;
  ubicacion_nombre: string | null;
  costo_unitario: number;
  fecha: string;
};
type Insumo = { producto_id: string; nombre: string; unidad: string | null; requerido: number; stock_actual: number; faltante: number; subcosto: number };
type Preview = {
  producto_nombre: string;
  ubicacion_nombre: string;
  insumos: Insumo[];
  costo_total: number;
  costo_unitario: number;
  hay_faltantes: boolean;
};
type Receta = { id: string; nombre: string | null; producto_nombre: string | null; rendimiento_unidad: string | null; activa: boolean };
type Ubicacion = { id: string; nombre: string; tipo: string };
type Producto = { id: string; nombre: string; clase_producto?: string; unidad_medida: string };

const INPUT =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";
const LABEL = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500";
const BTN = "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";

const ESTADO: Record<Estado, { label: string; cls: string }> = {
  planificada: { label: "Planificada", cls: "bg-sky-50 text-sky-700" },
  en_proceso: { label: "En proceso", cls: "bg-amber-50 text-amber-800" },
  finalizada: { label: "Finalizada", cls: "bg-emerald-50 text-emerald-700" },
  cancelada: { label: "Cancelada", cls: "bg-slate-100 text-slate-500" },
};

const gs = (n: number) => `Gs. ${Math.round(n).toLocaleString("es-PY")}`;
const num = (s: string) => parseFloat(s.replace(",", ".")) || 0;

type Resp<T> = { ok: true; data: T } | { ok: false; error: string; faltantes?: Insumo[]; status: number };
async function pedir<T>(url: string, init?: RequestInit): Promise<Resp<T>> {
  const r = await apiFetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T; faltantes?: Insumo[] };
  if (!r.ok || !j.success) return { ok: false, error: j.error ?? `Error ${r.status}`, faltantes: j.faltantes, status: r.status };
  return { ok: true, data: j.data as T };
}

export default function OrdenesProduccionPage() {
  const [ordenes, setOrdenes] = useState<Orden[]>([]);
  const [recetas, setRecetas] = useState<Receta[]>([]);
  const [depositos, setDepositos] = useState<Ubicacion[]>([]);
  const [intermedios, setIntermedios] = useState<Producto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ receta_id: "", cantidad: "", ubicacion_id: "", observaciones: "" });
  const [creada, setCreada] = useState<{ numero: string; preview: Preview } | null>(null);
  const [verPreview, setVerPreview] = useState<{ orden: Orden; preview: Preview } | null>(null);
  const [finalizando, setFinalizando] = useState<Orden | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    const r = await pedir<{ ordenes: Orden[] }>("/api/produccion/ordenes");
    if (r.ok) setOrdenes(r.data.ordenes);
    else setError(r.error);
  }, []);

  useEffect(() => {
    void cargar();
    pedir<{ recetas: Receta[] }>("/api/recetas").then((r) => r.ok && setRecetas(r.data.recetas.filter((x) => x.activa)));
    pedir<{ ubicaciones: Ubicacion[] }>("/api/inventario/ubicaciones").then((r) => {
      if (!r.ok) return;
      const deps = r.data.ubicaciones.filter((u) => u.tipo !== "camion");
      setDepositos(deps);
      // Por defecto se produce en la fábrica (el depósito que no es punto de venta).
      const fab = deps.find((u) => u.tipo !== "salon");
      if (fab) setForm((f) => ({ ...f, ubicacion_id: f.ubicacion_id || fab.id }));
    });
    pedir<{ productos: Producto[] }>("/api/productos").then(
      (r) => r.ok && setIntermedios(r.data.productos.filter((p) => p.clase_producto === "intermedio"))
    );
  }, [cargar]);

  async function crear() {
    setOcupado(true);
    setError(null);
    const r = await pedir<{ numero: string; preview: Preview }>("/api/produccion/ordenes", {
      method: "POST",
      body: JSON.stringify({ ...form, cantidad: num(form.cantidad) }),
    });
    setOcupado(false);
    if (!r.ok) return setError(r.error);
    setCreada(r.data);
    setForm((f) => ({ ...f, receta_id: "", cantidad: "", observaciones: "" }));
    void cargar();
  }

  async function accion(o: Orden, a: "iniciar" | "cancelar") {
    if (a === "cancelar" && !window.confirm(`¿Cancelar la orden ${o.numero ?? ""}?`)) return;
    const r = await pedir(`/api/produccion/ordenes/${o.id}`, { method: "PATCH", body: JSON.stringify({ accion: a }) });
    if (!r.ok) setError(r.error);
    void cargar();
  }

  async function mostrarPreview(o: Orden) {
    const r = await pedir<{ preview: Preview }>(`/api/produccion/ordenes/${o.id}`);
    if (r.ok) setVerPreview({ orden: o, preview: r.data.preview });
    else setError(r.error);
  }

  const abiertas = ordenes.filter((o) => o.estado === "planificada" || o.estado === "en_proceso");
  const cerradas = ordenes.filter((o) => o.estado === "finalizada" || o.estado === "cancelada");

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Formulaciones e insumos</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Órdenes de producción</h1>
          <p className="mt-1 text-sm text-slate-500">Planificada → En proceso → Finalizada. El stock se mueve al finalizar.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/recetas" className={BTN}>Formulaciones</Link>
          <Link href="/dashboard/recetas/mermas" className={BTN}>Mermas y devoluciones</Link>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Nueva orden</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className={LABEL} htmlFor="op-receta">Producto (formulación)</label>
            <select id="op-receta" className={INPUT} value={form.receta_id} onChange={(e) => setForm((f) => ({ ...f, receta_id: e.target.value }))}>
              <option value="">Elegir…</option>
              {recetas.map((r) => (
                <option key={r.id} value={r.id}>{r.producto_nombre ?? r.nombre ?? "Sin nombre"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="op-cant">Cantidad a producir</label>
            <input
              id="op-cant"
              inputMode="decimal"
              className={INPUT}
              placeholder="Ej: 10 (kg) o 100 (u)"
              value={form.cantidad}
              onChange={(e) => setForm((f) => ({ ...f, cantidad: e.target.value.replace(/[^0-9.,]/g, "") }))}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="op-dep">Depósito</label>
            <select id="op-dep" className={INPUT} value={form.ubicacion_id} onChange={(e) => setForm((f) => ({ ...f, ubicacion_id: e.target.value }))}>
              <option value="">Elegir…</option>
              {depositos.map((d) => (
                <option key={d.id} value={d.id}>{d.nombre}{d.tipo === "salon" ? " (Punto de venta)" : ""}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <label className={LABEL} htmlFor="op-obs">Observaciones (opcional)</label>
            <input id="op-obs" className={INPUT} value={form.observaciones} onChange={(e) => setForm((f) => ({ ...f, observaciones: e.target.value }))} />
          </div>
        </div>
        <button
          type="button"
          disabled={ocupado || !form.receta_id || num(form.cantidad) <= 0 || !form.ubicacion_id}
          onClick={() => void crear()}
          className="mt-4 rounded-xl bg-[#3F8E91] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {ocupado ? "Calculando…" : "Crear orden"}
        </button>
        {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        {creada ? (
          <div className="mt-4">
            <p className="text-sm font-semibold text-slate-800">Orden {creada.numero} creada. Materia prima necesaria:</p>
            <TablaInsumos preview={creada.preview} />
          </div>
        ) : null}
      </section>

      <ListaOrdenes
        titulo="En curso"
        ordenes={abiertas}
        vacio="No hay órdenes abiertas."
        acciones={(o) => (
          <div className="flex flex-wrap justify-end gap-1.5">
            <button type="button" className={BTN} onClick={() => void mostrarPreview(o)}>Materia prima</button>
            {o.estado === "planificada" ? (
              <button type="button" className={BTN} onClick={() => void accion(o, "iniciar")}>Iniciar</button>
            ) : null}
            <button type="button" className="rounded-lg bg-[#3F8E91] px-2.5 py-1.5 text-xs font-semibold text-white" onClick={() => setFinalizando(o)}>
              Finalizar
            </button>
            <button type="button" className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50" onClick={() => void accion(o, "cancelar")}>
              Cancelar
            </button>
          </div>
        )}
      />
      <ListaOrdenes titulo="Historial" ordenes={cerradas} vacio="Todavía no hay producciones finalizadas." />

      {verPreview ? (
        <Modal titulo={`Materia prima · ${verPreview.orden.numero ?? ""} ${verPreview.preview.producto_nombre}`} onCerrar={() => setVerPreview(null)}>
          <p className="mb-2 text-xs text-slate-500">Stock en {verPreview.preview.ubicacion_nombre}, al momento.</p>
          <TablaInsumos preview={verPreview.preview} />
        </Modal>
      ) : null}

      {finalizando ? (
        <ModalFinalizar
          orden={finalizando}
          intermedios={intermedios}
          onCerrar={() => setFinalizando(null)}
          onListo={() => { setFinalizando(null); void cargar(); }}
        />
      ) : null}
    </div>
  );
}

function TablaInsumos({ preview }: { preview: Preview }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
          <tr>
            <th className="py-1.5">Insumo</th>
            <th className="py-1.5 text-right">Necesario</th>
            <th className="py-1.5 text-right">Hay</th>
            <th className="py-1.5 text-right">Costo</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {preview.insumos.map((i) => (
            <tr key={i.producto_id} className={i.faltante > 0 ? "bg-rose-50/60" : ""}>
              <td className="py-1.5">{i.nombre}</td>
              <td className="py-1.5 text-right tabular-nums">{formatCantidad(i.requerido, i.unidad ?? "")} {i.unidad}</td>
              <td className={`py-1.5 text-right tabular-nums ${i.faltante > 0 ? "font-semibold text-rose-600" : ""}`}>
                {formatCantidad(i.stock_actual, i.unidad ?? "")}
                {i.faltante > 0 ? ` (faltan ${formatCantidad(i.faltante, i.unidad ?? "")})` : ""}
              </td>
              <td className="py-1.5 text-right tabular-nums">{gs(i.subcosto)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-slate-600">
        Costo total {gs(preview.costo_total)} · por unidad {gs(preview.costo_unitario)}
        {preview.hay_faltantes ? <span className="ml-2 font-semibold text-rose-600">Falta materia prima en el depósito.</span> : null}
      </p>
    </div>
  );
}

function ListaOrdenes({
  titulo, ordenes, vacio, acciones,
}: { titulo: string; ordenes: Orden[]; vacio: string; acciones?: (o: Orden) => React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{titulo}</h2>
      {ordenes.length === 0 ? (
        <p className="text-sm text-slate-400">{vacio}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="py-2">Orden</th>
                <th className="py-2">Producto</th>
                <th className="py-2 text-right">Planificado</th>
                <th className="py-2 text-right">Obtenido</th>
                <th className="py-2">Lote / vence</th>
                <th className="py-2">Depósito</th>
                <th className="py-2">Estado</th>
                {acciones ? <th /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ordenes.map((o) => (
                <tr key={o.id}>
                  <td className="py-2.5 font-mono text-xs text-slate-500">
                    {o.numero ?? "—"}
                    <span className="block font-sans text-[11px] text-slate-400">{new Date(o.fecha).toLocaleDateString("es-PY")}</span>
                  </td>
                  <td className="py-2.5 font-medium text-slate-800">{o.producto_nombre}</td>
                  <td className="py-2.5 text-right tabular-nums">{o.cantidad_planificada != null ? `${formatCantidad(o.cantidad_planificada, o.unidad ?? "")} ${o.unidad ?? ""}` : "—"}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {o.estado === "finalizada" ? `${formatCantidad(o.cantidad_fabricada, o.unidad ?? "")} ${o.unidad ?? ""}` : "—"}
                    {o.merma_cantidad > 0 ? <span className="block text-[11px] text-rose-600">merma {formatCantidad(o.merma_cantidad, o.unidad ?? "")}</span> : null}
                  </td>
                  <td className="py-2.5 text-xs">
                    {o.lote ?? "—"}
                    {o.fecha_vencimiento ? <span className="block text-slate-400">vence {new Date(`${o.fecha_vencimiento}T12:00:00`).toLocaleDateString("es-PY")}</span> : null}
                  </td>
                  <td className="py-2.5 text-xs">{o.ubicacion_nombre ?? "—"}</td>
                  <td className="py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ESTADO[o.estado].cls}`}>{ESTADO[o.estado].label}</span>
                  </td>
                  {acciones ? <td className="py-2.5">{acciones(o)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Modal({ titulo, onCerrar, children }: { titulo: string; onCerrar: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onCerrar}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-4">
          <h3 className="text-base font-semibold text-slate-800">{titulo}</h3>
          <button type="button" className="text-slate-400 hover:text-slate-600" onClick={onCerrar} aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalFinalizar({
  orden, intermedios, onCerrar, onListo,
}: { orden: Orden; intermedios: Producto[]; onCerrar: () => void; onListo: () => void }) {
  const [real, setReal] = useState(String(orden.cantidad_planificada ?? ""));
  const [merma, setMerma] = useState("");
  const [destino, setDestino] = useState<"desecho" | "galleta_molida">("desecho");
  const [galletaId, setGalletaId] = useState("");
  const [galletaCant, setGalletaCant] = useState("");
  const [faltantes, setFaltantes] = useState<Insumo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<{ lote: string; fecha_vencimiento: string | null; aviso_merma: string | null } | null>(null);

  // Si se planificaron 10 y salieron 9,2, se sugiere 0,8 de merma.
  const mermaSugerida = useMemo(() => {
    const p = orden.cantidad_planificada ?? 0;
    const r = num(real);
    return r > 0 && r < p ? Math.round((p - r) * 1000) / 1000 : 0;
  }, [real, orden.cantidad_planificada]);

  async function finalizar(permitirSinStock = false) {
    setOcupado(true);
    setError(null);
    const r = await pedir<{ produccion: { lote: string; fecha_vencimiento: string | null; aviso_merma: string | null } }>(
      `/api/produccion/ordenes/${orden.id}/finalizar`,
      {
        method: "POST",
        body: JSON.stringify({
          cantidad_real: num(real),
          merma_cantidad: merma === "" ? 0 : num(merma),
          merma_destino: num(merma) > 0 ? destino : null,
          galleta_producto_id: destino === "galleta_molida" ? galletaId || null : null,
          galleta_cantidad: destino === "galleta_molida" && galletaCant ? num(galletaCant) : null,
          permitir_sin_stock: permitirSinStock,
        }),
      }
    );
    setOcupado(false);
    if (r.ok) return setResultado(r.data.produccion);
    if (r.status === 409 && r.faltantes) return setFaltantes(r.faltantes);
    setError(r.error);
  }

  if (resultado) {
    return (
      <Modal titulo={`Orden ${orden.numero ?? ""} finalizada`} onCerrar={onListo}>
        <p className="text-sm text-slate-700">
          Entró al stock con lote <strong>{resultado.lote}</strong>
          {resultado.fecha_vencimiento ? <> y vence el <strong>{new Date(`${resultado.fecha_vencimiento}T12:00:00`).toLocaleDateString("es-PY")}</strong></> : null}.
        </p>
        {resultado.aviso_merma ? <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{resultado.aviso_merma}</p> : null}
        <button type="button" className="mt-4 rounded-xl bg-[#3F8E91] px-4 py-2 text-sm font-semibold text-white" onClick={onListo}>Listo</button>
      </Modal>
    );
  }

  return (
    <Modal titulo={`Finalizar ${orden.numero ?? ""} · ${orden.producto_nombre}`} onCerrar={onCerrar}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="f-real">Cantidad real producida ({orden.unidad})</label>
          <input id="f-real" inputMode="decimal" className={INPUT} value={real} onChange={(e) => setReal(e.target.value.replace(/[^0-9.,]/g, ""))} />
          <p className="mt-1 text-[11px] text-slate-400">Planificado: {orden.cantidad_planificada}</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="f-merma">Merma</label>
          <input id="f-merma" inputMode="decimal" className={INPUT} placeholder={mermaSugerida ? String(mermaSugerida) : "0"} value={merma} onChange={(e) => setMerma(e.target.value.replace(/[^0-9.,]/g, ""))} />
          {mermaSugerida > 0 && merma === "" ? (
            <button type="button" className="mt-1 text-[11px] font-semibold text-[#3F8E91]" onClick={() => setMerma(String(mermaSugerida))}>
              Usar {mermaSugerida} (planificado − real)
            </button>
          ) : null}
        </div>
      </div>

      {num(merma) > 0 ? (
        <div className="mt-3 rounded-xl border border-slate-200 p-3">
          <p className={LABEL}>¿A dónde va la merma?</p>
          <div className="flex gap-2">
            {(["desecho", "galleta_molida"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDestino(d)}
                className={`rounded-lg border px-3 py-1.5 text-sm ${destino === d ? "border-[#4FAEB2] bg-[#4FAEB2]/10 font-semibold" : "border-slate-200"}`}
              >
                {d === "desecho" ? "Desecho" : "Galleta molida"}
              </button>
            ))}
          </div>
          {destino === "galleta_molida" ? (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor="f-gal">Producto intermedio</label>
                <select id="f-gal" className={INPUT} value={galletaId} onChange={(e) => setGalletaId(e.target.value)}>
                  <option value="">Elegir…</option>
                  {intermedios.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
                {intermedios.length === 0 ? (
                  <p className="mt-1 text-[11px] text-amber-700">Cargá primero un producto de clase Intermedio (ej. GALLETA MOLIDA).</p>
                ) : null}
              </div>
              <div>
                <label className={LABEL} htmlFor="f-galc">Cantidad que entra</label>
                <input id="f-galc" inputMode="decimal" className={INPUT} placeholder={merma} value={galletaCant} onChange={(e) => setGalletaCant(e.target.value.replace(/[^0-9.,]/g, ""))} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {faltantes ? (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <p className="font-semibold">Falta materia prima en el depósito:</p>
          <ul className="mt-1 list-disc pl-5">
            {faltantes.map((f) => <li key={f.producto_id}>{f.nombre}: hay {f.stock_actual}, se necesitan {f.requerido}</li>)}
          </ul>
          <button type="button" disabled={ocupado} className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white" onClick={() => void finalizar(true)}>
            Finalizar igual (el stock de esos insumos queda en 0)
          </button>
        </div>
      ) : null}

      {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={ocupado || num(real) <= 0} className="rounded-xl bg-[#3F8E91] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void finalizar(false)}>
          {ocupado ? "Registrando…" : "Finalizar y mover stock"}
        </button>
        <button type="button" className={BTN} onClick={onCerrar}>Cancelar</button>
      </div>
    </Modal>
  );
}
