"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";

/**
 * RRHH › Asistencia › Marcaciones (solo administradores).
 *
 * Cada marcación que hizo un empleado (entrada, breaks, almuerzo, salida), con
 * filtros por empleado, fechas y tipo; las jornadas que quedaron sin salida; y
 * la corrección de un día con motivo obligatorio, que deja registrado quién la
 * hizo, cuándo y el valor anterior y el nuevo.
 */

type TipoEvento = "entrada" | "inicio_break" | "fin_break" | "inicio_almuerzo" | "fin_almuerzo" | "salida";

export const ETIQUETA: Record<TipoEvento, string> = {
  entrada: "Entrada",
  inicio_break: "Inicio de break",
  fin_break: "Fin de break",
  inicio_almuerzo: "Inicio de almuerzo",
  fin_almuerzo: "Fin de almuerzo",
  salida: "Salida",
};

const COLOR: Record<TipoEvento, string> = {
  entrada: "bg-emerald-50 text-emerald-700 border-emerald-200",
  inicio_break: "bg-amber-50 text-amber-800 border-amber-200",
  fin_break: "bg-amber-50/60 text-amber-700 border-amber-100",
  inicio_almuerzo: "bg-sky-50 text-sky-700 border-sky-200",
  fin_almuerzo: "bg-sky-50/60 text-sky-600 border-sky-100",
  salida: "bg-slate-100 text-slate-700 border-slate-200",
};

const ORIGEN: Record<string, string> = { autoservicio: "Marcó el empleado", admin: "Corrección", reloj: "Reloj", importacion: "Importado" };

type Marcacion = {
  id: string;
  empleado_id: string;
  empleado: string;
  documento: string | null;
  codigo: string | null;
  jornada: string;
  tipo: TipoEvento;
  hora: string;
  origen: string;
  sesion_usuario_nombre: string | null;
  anulado: boolean;
  corregido: boolean;
};

type Incompleta = { empleado_id: string; empleado: string; jornada: string; ultima: string; ultimo_tipo: TipoEvento };

type Detalle = {
  empleado: { id: string; nombre: string };
  jornada: string;
  eventos: {
    id: string;
    tipo: TipoEvento;
    hora: string;
    origen: string;
    sesion_usuario_nombre: string | null;
    anulado: boolean;
    corregido?: boolean;
  }[];
  correcciones: {
    accion: "agregar" | "modificar" | "anular";
    antes: { tipo?: TipoEvento; hora?: string } | null;
    despues: { tipo?: TipoEvento; hora?: string; hasta?: string; anulado?: boolean } | null;
    motivo: string;
    usuario_nombre: string | null;
    cuando: string;
  }[];
  totales?: { trabajado_min: number | null; break_min: number; almuerzo_min: number; fuera_min: number; avisos: string[] };
};

const esInicioPausa = (t: TipoEvento) => t === "inicio_break" || t === "inicio_almuerzo";

const hm = (min: number) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")} min`;

const INPUT =
  "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 disabled:bg-slate-50 disabled:text-slate-400";
const LABEL = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500";
const BTN_PRIMARY =
  "rounded-lg bg-[#3F8E91] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#357a7d] disabled:opacity-50";
const BTN_GHOST =
  "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50";

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T };
  if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
  return j.data as T;
}

const fechaCorta = (f: string) => f.split("-").reverse().join("/");

/** Lo dispara la pantalla "Marcar asistencia" cada vez que alguien marca. */
export const EVENTO_MARCACION = "rrhh:marcacion";

function hoyPY(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Asuncion", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function restarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

export function Marcaciones({ empleados }: { empleados: { id: string; nombre: string }[] }) {
  const [desde, setDesde] = useState(() => restarDias(hoyPY(), 6));
  const [hasta, setHasta] = useState(() => hoyPY());
  const [empleado, setEmpleado] = useState("");
  const [tipo, setTipo] = useState("");
  const [anuladas, setAnuladas] = useState(false);
  const [filas, setFilas] = useState<Marcacion[]>([]);
  const [incompletas, setIncompletas] = useState<Incompleta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dia, setDia] = useState<{ empleadoId: string; fecha: string } | null>(null);
  const [exportando, setExportando] = useState(false);

  const query = useCallback(() => {
    const q = new URLSearchParams({ desde, hasta });
    if (empleado) q.set("empleado", empleado);
    if (tipo) q.set("tipo", tipo);
    if (anuladas) q.set("anuladas", "1");
    return q.toString();
  }, [desde, hasta, empleado, tipo, anuladas]);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const [m, inc] = await Promise.all([
        pedir<{ marcaciones: Marcacion[] }>(`/api/rrhh/marcaciones?${query()}`),
        pedir<{ jornadas: Incompleta[] }>("/api/rrhh/marcaciones/incompletas"),
      ]);
      setFilas(m.marcaciones);
      setIncompletas(inc.jornadas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFilas([]);
    } finally {
      setCargando(false);
    }
  }, [query]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Alguien marcó con el botón de arriba mientras esta pestaña estaba abierta.
  useEffect(() => {
    const alMarcar = () => void cargar();
    window.addEventListener(EVENTO_MARCACION, alMarcar);
    return () => window.removeEventListener(EVENTO_MARCACION, alMarcar);
  }, [cargar]);

  async function exportar() {
    setExportando(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/rrhh/marcaciones/exportar?${query()}`);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Error ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `marcaciones_${desde}_${hasta}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportando(false);
    }
  }

  // Agrupado por día y empleado, para leer la jornada de corrido.
  const grupos: { clave: string; empleadoId: string; empleado: string; jornada: string; eventos: Marcacion[] }[] = [];
  for (const f of filas) {
    const clave = `${f.jornada}|${f.empleado_id}`;
    let g = grupos.find((x) => x.clave === clave);
    if (!g) {
      g = { clave, empleadoId: f.empleado_id, empleado: f.empleado, jornada: f.jornada, eventos: [] };
      grupos.push(g);
    }
    g.eventos.push(f);
  }
  for (const g of grupos) g.eventos.reverse();

  return (
    <div className="space-y-5">
      {incompletas.length > 0 ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <span aria-hidden="true">⚠</span> {incompletas.length === 1 ? "1 jornada quedó sin salida" : `${incompletas.length} jornadas quedaron sin salida`}
          </h2>
          <p className="mt-0.5 text-xs text-amber-800">No suman horas hasta que las corrijas. Cargá la salida con el motivo.</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {incompletas.map((j) => (
              <li key={`${j.empleado_id}${j.jornada}`}>
                <button
                  type="button"
                  onClick={() => setDia({ empleadoId: j.empleado_id, fecha: j.jornada })}
                  className="rounded-xl border border-amber-300 bg-white px-3 py-2 text-left text-xs shadow-sm transition hover:border-amber-400 hover:shadow"
                >
                  <span className="block font-semibold text-slate-800">{j.empleado}</span>
                  <span className="text-slate-500">
                    {fechaCorta(j.jornada)} · último: {ETIQUETA[j.ultimo_tipo].toLowerCase()} {j.ultima}
                  </span>
                  <span className="ml-2 font-semibold text-[#3F8E91]">Corregir →</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-[1fr_1fr_2fr_1.4fr_auto]">
          <div>
            <label className={LABEL} htmlFor="mc-desde">Desde</label>
            <input id="mc-desde" type="date" className={`${INPUT} w-full`} value={desde} max={hasta} onChange={(e) => e.target.value && setDesde(e.target.value)} />
          </div>
          <div>
            <label className={LABEL} htmlFor="mc-hasta">Hasta</label>
            <input id="mc-hasta" type="date" className={`${INPUT} w-full`} value={hasta} min={desde} onChange={(e) => e.target.value && setHasta(e.target.value)} />
          </div>
          <div className="col-span-2 md:col-span-1">
            <label className={LABEL} htmlFor="mc-emp">Empleado</label>
            <select id="mc-emp" className={`${INPUT} w-full`} value={empleado} onChange={(e) => setEmpleado(e.target.value)}>
              <option value="">Todos</option>
              {empleados.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="mc-tipo">Tipo</label>
            <select id="mc-tipo" className={`${INPUT} w-full`} value={tipo} onChange={(e) => setTipo(e.target.value)}>
              <option value="">Todas</option>
              {(Object.keys(ETIQUETA) as TipoEvento[]).map((t) => <option key={t} value={t}>{ETIQUETA[t]}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button type="button" className={`${BTN_PRIMARY} w-full whitespace-nowrap`} disabled={exportando || filas.length === 0} onClick={() => void exportar()}>
              {exportando ? "Exportando…" : "⬇ Excel"}
            </button>
          </div>
        </div>
        <label className="mt-3 inline-flex items-center gap-2 text-xs text-slate-500">
          <input type="checkbox" checked={anuladas} onChange={(e) => setAnuladas(e.target.checked)} />
          Mostrar también las anuladas
        </label>

        {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

        <div className="mt-4 space-y-2">
          {cargando ? (
            <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
          ) : grupos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">
              No hay marcaciones en ese rango.
              <span className="mt-1 block text-xs text-slate-400">Los empleados marcan desde el botón “Marcar asistencia” de arriba.</span>
            </div>
          ) : (
            grupos.map((g) => (
              <div key={g.clave} className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5 sm:flex-row sm:items-center">
                <div className="min-w-[11rem]">
                  <span className="block text-sm font-semibold text-slate-800">{g.empleado}</span>
                  <span className="text-xs tabular-nums text-slate-400">{fechaCorta(g.jornada)}</span>
                </div>
                <ol className="flex flex-1 flex-wrap items-center gap-1.5">
                  {g.eventos.map((ev) => (
                    <li
                      key={ev.id}
                      title={`${ORIGEN[ev.origen] ?? ev.origen}${ev.sesion_usuario_nombre ? ` · sesión de ${ev.sesion_usuario_nombre}` : ""}${ev.corregido ? " · corregida" : ""}`}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${COLOR[ev.tipo]} ${ev.anulado ? "line-through opacity-50" : ""}`}
                    >
                      <span className="font-semibold tabular-nums">{ev.hora}</span>
                      <span>{ETIQUETA[ev.tipo]}</span>
                      {ev.origen === "admin" || ev.corregido ? <span aria-label="corregida" className="text-[10px]">✎</span> : null}
                    </li>
                  ))}
                </ol>
                <button type="button" className={BTN_GHOST} onClick={() => setDia({ empleadoId: g.empleadoId, fecha: g.jornada })}>
                  Ver / corregir
                </button>
              </div>
            ))
          )}
        </div>
        {filas.length >= 2000 ? <p className="mt-2 text-xs text-amber-700">Se muestran las últimas 2000. Achicá el rango para ver todo.</p> : null}
      </section>

      {dia ? (
        <DiaModal
          empleadoId={dia.empleadoId}
          fecha={dia.fecha}
          onCerrar={() => setDia(null)}
          onCambio={() => void cargar()}
        />
      ) : null}
    </div>
  );
}

// ─── Detalle y corrección de un día ───────────────────────────────────────

type Edicion =
  | { accion: "agregar"; tipo: TipoEvento; hora: string; horaFin?: string }
  | { accion: "modificar"; eventoId: string; tipo: TipoEvento; hora: string }
  | { accion: "anular"; eventoId: string; tipo: TipoEvento; hora: string };

export function DiaModal({
  empleadoId,
  fecha,
  onCerrar,
  onCambio,
}: {
  empleadoId: string;
  fecha: string;
  onCerrar: () => void;
  onCambio: () => void;
}) {
  const [d, setD] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ed, setEd] = useState<Edicion | null>(null);
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    pedir<Detalle>(`/api/rrhh/marcaciones/dia?empleado=${empleadoId}&fecha=${fecha}`)
      .then(setD)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [empleadoId, fecha]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCerrar]);

  async function guardar() {
    if (!ed) return;
    setGuardando(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { empleado_id: empleadoId, fecha, accion: ed.accion, motivo };
      if (ed.accion === "agregar") Object.assign(body, { tipo: ed.tipo, hora: ed.hora, hora_fin: esInicioPausa(ed.tipo) ? ed.horaFin : undefined });
      if (ed.accion === "modificar") Object.assign(body, { evento_id: ed.eventoId, hora: ed.hora });
      if (ed.accion === "anular") Object.assign(body, { evento_id: ed.eventoId });
      setD(await pedir<Detalle>("/api/rrhh/marcaciones/corregir", { method: "POST", body: JSON.stringify(body) }));
      setEd(null);
      setMotivo("");
      onCambio();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }

  const validos = d?.eventos.filter((e) => !e.anulado) ?? [];
  const sugerido: TipoEvento = validos.length ? "salida" : "entrada";

  const describir = (v: { tipo?: TipoEvento; hora?: string; hasta?: string; anulado?: boolean } | null) =>
    !v ? "—" : v.anulado ? "anulada" : `${v.tipo ? ETIQUETA[v.tipo] : ""} ${v.hora ?? ""}${v.hasta ? ` a ${v.hasta}` : ""}`.trim();

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onCerrar}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Marcaciones del día"
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Marcaciones del día</p>
            <h2 className="mt-0.5 text-lg font-semibold text-slate-900">{d?.empleado.nombre ?? "…"}</h2>
            <p className="text-sm capitalize text-slate-500">
              {new Date(`${fecha}T12:00:00Z`).toLocaleDateString("es-PY", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}
            </p>
          </div>
          <button type="button" onClick={onCerrar} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Cerrar">
            ✕
          </button>
        </div>

        {!d && !error ? <p className="py-8 text-center text-sm text-slate-400">Cargando…</p> : null}

        {d ? (
          <ol className="mt-4 space-y-1.5">
            {d.eventos.length === 0 ? <li className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-500">Sin marcaciones este día.</li> : null}
            {d.eventos.map((ev) => (
              <li
                key={ev.id}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${ev.anulado ? "border-dashed border-slate-200 opacity-50" : "border-slate-100"} ${ed && "eventoId" in ed && ed.eventoId === ev.id ? "ring-2 ring-[#4FAEB2]/40" : ""}`}
              >
                <span className={`w-14 text-center font-mono text-sm font-semibold tabular-nums ${ev.anulado ? "line-through" : ""}`}>{ev.hora}</span>
                <span className="flex-1">
                  <span className={`block text-sm font-medium ${ev.anulado ? "line-through" : "text-slate-800"}`}>{ETIQUETA[ev.tipo]}</span>
                  <span className="text-[11px] text-slate-400">
                    {ORIGEN[ev.origen] ?? ev.origen}
                    {ev.sesion_usuario_nombre ? ` · ${ev.origen === "admin" ? "por" : "sesión de"} ${ev.sesion_usuario_nombre}` : ""}
                    {ev.anulado ? " · anulada" : ev.corregido ? " · hora corregida (ver historial)" : ""}
                  </span>
                </span>
                {!ev.anulado ? (
                  <span className="flex gap-1">
                    <button type="button" className={BTN_GHOST} onClick={() => { setEd({ accion: "modificar", eventoId: ev.id, tipo: ev.tipo, hora: ev.hora }); setError(null); }}>
                      Hora
                    </button>
                    <button type="button" className={`${BTN_GHOST} hover:border-rose-200 hover:text-rose-700`} onClick={() => { setEd({ accion: "anular", eventoId: ev.id, tipo: ev.tipo, hora: ev.hora }); setError(null); }}>
                      Anular
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {d?.totales && d.eventos.some((e) => !e.anulado) ? (
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-[#4FAEB2]/10 px-2 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#2F7A7D]">Trabajado</p>
              <p className="text-sm font-semibold tabular-nums text-slate-800">
                {d.totales.trabajado_min != null ? hm(d.totales.trabajado_min) : "sin salida"}
              </p>
            </div>
            <div className="rounded-xl bg-amber-50 px-2 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-800">Breaks</p>
              <p className="text-sm font-semibold tabular-nums text-slate-800">{d.totales.break_min} min</p>
            </div>
            <div className="rounded-xl bg-sky-50 px-2 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700">Almuerzo</p>
              <p className="text-sm font-semibold tabular-nums text-slate-800">{d.totales.almuerzo_min} min</p>
            </div>
            {d.totales.fuera_min > 0 ? (
              <p className="col-span-3 text-xs text-slate-500">Afuera entre salida y reingreso: {d.totales.fuera_min} min (no cuenta como trabajado).</p>
            ) : null}
            {d.totales.avisos.map((a) => (
              <p key={a} className="col-span-3 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">⚠ {a}</p>
            ))}
          </div>
        ) : null}

        {d && !ed ? (
          <button
            type="button"
            className="mt-3 w-full rounded-xl border border-dashed border-[#4FAEB2]/60 py-2 text-sm font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/5"
            onClick={() => { setEd({ accion: "agregar", tipo: sugerido, hora: "" }); setError(null); }}
          >
            + Agregar marcación
          </button>
        ) : null}

        {ed ? (
          <div className="mt-4 rounded-2xl border border-[#4FAEB2]/30 bg-[#4FAEB2]/5 p-4">
            <p className="text-sm font-semibold text-slate-800">
              {ed.accion === "agregar" ? "Agregar marcación" : ed.accion === "modificar" ? `Cambiar la hora de “${ETIQUETA[ed.tipo]}”` : `Anular “${ETIQUETA[ed.tipo]}” de las ${ed.hora}`}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {ed.accion === "agregar" ? (
                <div>
                  <label className={LABEL} htmlFor="dc-tipo">Tipo</label>
                  <select id="dc-tipo" className={`${INPUT} w-full`} value={ed.tipo} onChange={(e) => setEd({ ...ed, tipo: e.target.value as TipoEvento })}>
                    {(Object.keys(ETIQUETA) as TipoEvento[]).map((t) => <option key={t} value={t}>{ETIQUETA[t]}</option>)}
                  </select>
                </div>
              ) : null}
              {ed.accion !== "anular" ? (
                <div>
                  <label className={LABEL} htmlFor="dc-hora">{ed.accion === "agregar" && esInicioPausa(ed.tipo) ? "Desde" : "Hora"}</label>
                  <input id="dc-hora" type="time" className={`${INPUT} w-full`} value={ed.hora} onChange={(e) => setEd({ ...ed, hora: e.target.value })} />
                </div>
              ) : null}
              {ed.accion === "agregar" && esInicioPausa(ed.tipo) ? (
                <div>
                  <label className={LABEL} htmlFor="dc-hasta">Hasta</label>
                  <input id="dc-hasta" type="time" className={`${INPUT} w-full`} value={ed.horaFin ?? ""} onChange={(e) => setEd({ ...ed, horaFin: e.target.value })} />
                </div>
              ) : null}
              {ed.accion === "agregar" && esInicioPausa(ed.tipo) ? (
                <p className="col-span-2 -mt-1 text-[11px] text-slate-500">Se agregan el inicio y el fin juntos.</p>
              ) : null}
              <div className="col-span-2">
                <label className={LABEL} htmlFor="dc-motivo">Motivo *</label>
                <input
                  id="dc-motivo"
                  className={`${INPUT} w-full`}
                  value={motivo}
                  maxLength={300}
                  autoFocus
                  placeholder="Ej: se olvidó de marcar la salida, confirmado con el encargado"
                  onChange={(e) => setMotivo(e.target.value)}
                />
              </div>
            </div>
            {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className={ed.accion === "anular" ? "rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50" : BTN_PRIMARY}
                disabled={
                  guardando ||
                  motivo.trim().length < 3 ||
                  (ed.accion !== "anular" && !ed.hora) ||
                  (ed.accion === "agregar" && esInicioPausa(ed.tipo) && !ed.horaFin)
                }
                onClick={() => void guardar()}
              >
                {guardando ? "Guardando…" : ed.accion === "anular" ? "Anular" : "Guardar"}
              </button>
              <button type="button" className={BTN_GHOST} onClick={() => { setEd(null); setError(null); }}>
                Cancelar
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Queda registrado quién corrigió, cuándo, el motivo y el valor anterior.</p>
          </div>
        ) : error ? (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        ) : null}

        {d && d.correcciones.length > 0 ? (
          <div className="mt-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Historial de correcciones</h3>
            <ul className="mt-2 space-y-1.5">
              {d.correcciones.map((c, i) => (
                <li key={i} className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold text-slate-800">{c.usuario_nombre ?? "Administrador"}</span> · {c.cuando}
                  <span className="mt-0.5 block">
                    {c.accion === "agregar" ? "Agregó" : c.accion === "modificar" ? "Cambió" : "Anuló"}{" "}
                    {c.accion === "agregar" ? (
                      <b>{describir(c.despues)}</b>
                    ) : c.accion === "modificar" ? (
                      <>
                        <span className="line-through">{describir(c.antes)}</span> → <b>{c.despues?.hora}</b>
                      </>
                    ) : (
                      <b>{describir(c.antes)}</b>
                    )}
                  </span>
                  <span className="mt-0.5 block italic text-slate-500">“{c.motivo}”</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
