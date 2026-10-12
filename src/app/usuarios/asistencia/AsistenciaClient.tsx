"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import { useIsAdmin } from "@/lib/auth/use-is-admin";

/**
 * RRHH › Asistencia. Tres vistas:
 *  - Planilla del día: cada empleado con su estado, entrada y salida.
 *  - Resumen del mes: días por estado y horas trabajadas, por empleado.
 *  - Empleados: la nómina a la que se le toma asistencia.
 *
 * Las horas se manejan en hora de Paraguay sin importar la zona del equipo.
 */

type Estado = "presente" | "tarde" | "ausente" | "permiso" | "vacaciones" | "reposo";

type Empleado = {
  id: string;
  nombre: string;
  documento: string | null;
  cargo: string | null;
  telefono: string | null;
  horario_entrada: string | null;
  horario_salida: string | null;
  activo: boolean;
  salario_base: number | null;
  tipo_remuneracion: "mensual" | "jornal";
  fecha_ingreso: string | null;
  aporta_ips: boolean;
  comision_pct: number | null;
};

type Fila = {
  empleado: Empleado;
  asistencia: {
    id: string; estado: Estado; entrada: string | null; salida: string | null; observacion: string | null;
    justificada: boolean | null;
  } | null;
};

type Resumen = {
  empleado_id: string;
  nombre: string;
  cargo: string | null;
  presente: number;
  tarde: number;
  ausente: number;
  permiso: number;
  vacaciones: number;
  reposo: number;
  minutos: number;
  sin_salida: number;
  ausente_justificada: number;
  ausente_injustificada: number;
  minutos_extra: number;
};

type Liquidacion = {
  empleado_id: string;
  nombre: string;
  tipo_remuneracion: string;
  salario_base: number | null;
  dias_trabajados: number;
  ausencias_injustificadas: number;
  horas_extra: number;
  monto_base: number;
  descuento_ausencias: number;
  monto_extras: number;
  monto_comision: number;
  bruto: number;
  ips_obrero: number;
  ips_patronal: number;
  aguinaldo_provision: number;
  neto: number;
  aviso: string | null;
};

const ZONA = "America/Asuncion";

const ESTADOS: { valor: Estado; etiqueta: string; cls: string }[] = [
  { valor: "presente", etiqueta: "Presente", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { valor: "tarde", etiqueta: "Tarde", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  { valor: "ausente", etiqueta: "Ausente", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  { valor: "permiso", etiqueta: "Permiso", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  { valor: "vacaciones", etiqueta: "Vacaciones", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  { valor: "reposo", etiqueta: "Reposo", cls: "bg-slate-100 text-slate-700 border-slate-200" },
];
const estiloEstado = (e: Estado | null) => ESTADOS.find((x) => x.valor === e)?.cls ?? "bg-white text-slate-500 border-slate-200";

const INPUT =
  "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 disabled:bg-slate-50 disabled:text-slate-400";
const BTN_PRIMARY =
  "rounded-lg bg-[#3F8E91] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#357a7d] disabled:opacity-50";
const BTN_GHOST =
  "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50";

/** Fecha y hora de ahora en Paraguay. */
function ahoraPY(): { fecha: string; hora: string; mes: string } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return {
    fecha: `${partes.year}-${partes.month}-${partes.day}`,
    hora: `${partes.hour}:${partes.minute}`,
    mes: `${partes.year}-${partes.month}`,
  };
}

function moverDia(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fechaLarga(fecha: string): string {
  return new Date(`${fecha}T12:00:00Z`).toLocaleDateString("es-PY", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function horas(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T };
  if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
  return j.data as T;
}

export default function AsistenciaClient() {
  const [vista, setVista] = useState<"planilla" | "resumen" | "vacaciones" | "empleados">("planilla");
  const { isAdmin, loaded } = useIsAdmin();

  return (
    <div className="space-y-6 pb-10">
      <div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">RRHH</p>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Asistencia</h1>
        <p className="mt-1 text-sm text-slate-500">
          Entrada, salida y ausencias del personal.{" "}
          <Link href="/usuarios" className="text-[#3F8E91] hover:underline">
            Usuarios del sistema →
          </Link>
        </p>
      </div>

      <div role="tablist" className="inline-flex flex-wrap rounded-xl border border-slate-200 bg-slate-50 p-1">
        {([
          { id: "planilla", label: "Planilla del día" },
          { id: "resumen", label: "Resumen y liquidación" },
          { id: "vacaciones", label: "Vacaciones y reposos" },
          { id: "empleados", label: "Empleados" },
        ] as const).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={vista === t.id}
            onClick={() => setVista(t.id)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${
              vista === t.id ? "bg-white text-[#3F8E91] shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loaded && !isAdmin ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Estás en modo consulta: marcar asistencia y editar empleados lo hace un administrador.
        </p>
      ) : null}

      {vista === "planilla" ? <Planilla puedeEditar={isAdmin} irAEmpleados={() => setVista("empleados")} /> : null}
      {vista === "resumen" ? <ResumenMes esAdmin={isAdmin} /> : null}
      {vista === "vacaciones" ? <Vacaciones puedeEditar={isAdmin} /> : null}
      {vista === "empleados" ? <Empleados puedeEditar={isAdmin} /> : null}
    </div>
  );
}

// ─── Planilla del día ─────────────────────────────────────────────────────

function Planilla({ puedeEditar, irAEmpleados }: { puedeEditar: boolean; irAEmpleados: () => void }) {
  const [fecha, setFecha] = useState(() => ahoraPY().fecha);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);
  const hoy = ahoraPY().fecha;

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const d = await pedir<{ filas: Fila[] }>(`/api/rrhh/asistencia?fecha=${fecha}`);
      setFilas(d.filas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFilas([]);
    } finally {
      setCargando(false);
    }
  }, [fecha]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar(empleadoId: string, cambios: Record<string, unknown>) {
    setGuardando(empleadoId);
    setError(null);
    try {
      const d = await pedir<{ filas: Fila[] }>("/api/rrhh/asistencia", {
        method: "PUT",
        body: JSON.stringify({ empleado_id: empleadoId, fecha, ...cambios }),
      });
      setFilas(d.filas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(null);
    }
  }

  const conteo = useMemo(() => {
    const c: Record<string, number> = { sin_marcar: 0 };
    for (const f of filas) {
      const k = f.asistencia?.estado ?? "sin_marcar";
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [filas]);

  /** Marca presente (o tarde, según el horario) a todos los que no tienen nada. */
  async function todosPresentes() {
    const pendientes = filas.filter((f) => !f.asistencia && f.empleado.activo);
    for (const f of pendientes) {
      await guardar(f.empleado.id, { entrada: f.empleado.horario_entrada ?? ahoraPY().hora });
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_GHOST} onClick={() => setFecha((f) => moverDia(f, -1))} aria-label="Día anterior">
          ◀
        </button>
        <input type="date" className={INPUT} value={fecha} max={hoy} onChange={(e) => e.target.value && setFecha(e.target.value)} />
        <button
          type="button"
          className={BTN_GHOST}
          onClick={() => setFecha((f) => moverDia(f, 1))}
          disabled={fecha >= hoy}
          aria-label="Día siguiente"
        >
          ▶
        </button>
        {fecha !== hoy ? (
          <button type="button" className={BTN_GHOST} onClick={() => setFecha(hoy)}>
            Hoy
          </button>
        ) : null}
        <span className="ml-1 text-sm capitalize text-slate-600">{fechaLarga(fecha)}</span>

        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-xs">
          {ESTADOS.filter((e) => conteo[e.valor]).map((e) => (
            <span key={e.valor} className={`rounded-full border px-2 py-0.5 font-semibold ${e.cls}`}>
              {e.etiqueta}: {conteo[e.valor]}
            </span>
          ))}
          {conteo.sin_marcar ? (
            <span className="rounded-full border border-slate-200 px-2 py-0.5 font-semibold text-slate-500">
              Sin marcar: {conteo.sin_marcar}
            </span>
          ) : null}
        </div>
      </div>

      {error ? <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      {puedeEditar && conteo.sin_marcar > 0 && !cargando ? (
        <div className="mb-3">
          <button type="button" className={BTN_GHOST} onClick={() => void todosPresentes()} disabled={guardando !== null}>
            Marcar presentes a los {conteo.sin_marcar} sin marcar
          </button>
          <span className="ml-2 text-xs text-slate-400">Con su hora de entrada habitual. Después corregí a quien faltó.</span>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            <tr>
              <th className="px-3 py-2.5">Empleado</th>
              <th className="px-3 py-2.5">Estado</th>
              <th className="px-3 py-2.5">Entrada</th>
              <th className="px-3 py-2.5">Salida</th>
              <th className="px-3 py-2.5">Observación</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {cargando ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-slate-400">Cargando…</td>
              </tr>
            ) : filas.length === 0 && !error ? (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-slate-500">
                  Todavía no hay empleados cargados.{" "}
                  <button type="button" className="font-semibold text-[#3F8E91] hover:underline" onClick={irAEmpleados}>
                    Cargar empleados
                  </button>
                </td>
              </tr>
            ) : (
              filas.map((f) => (
                <FilaPlanilla
                  key={f.empleado.id}
                  fila={f}
                  puedeEditar={puedeEditar && f.empleado.activo}
                  guardando={guardando === f.empleado.id}
                  esHoy={fecha === hoy}
                  onGuardar={(c) => guardar(f.empleado.id, c)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FilaPlanilla({
  fila,
  puedeEditar,
  guardando,
  esHoy,
  onGuardar,
}: {
  fila: Fila;
  puedeEditar: boolean;
  guardando: boolean;
  esHoy: boolean;
  onGuardar: (cambios: Record<string, unknown>) => void;
}) {
  const a = fila.asistencia;
  const [entrada, setEntrada] = useState(a?.entrada ?? "");
  const [salida, setSalida] = useState(a?.salida ?? "");
  const [obs, setObs] = useState(a?.observacion ?? "");
  useEffect(() => {
    setEntrada(a?.entrada ?? "");
    setSalida(a?.salida ?? "");
    setObs(a?.observacion ?? "");
  }, [a?.entrada, a?.salida, a?.observacion]);

  const conHoras = !a || a.estado === "presente" || a.estado === "tarde";
  const e = fila.empleado;

  return (
    <tr className={guardando ? "opacity-60" : ""}>
      <td className="px-3 py-2.5">
        <span className="block font-medium text-slate-800">{e.nombre}</span>
        <span className="block text-xs text-slate-400">
          {[e.cargo, e.horario_entrada ? `entra ${e.horario_entrada}` : null, e.activo ? null : "dado de baja"]
            .filter(Boolean)
            .join(" · ") || "—"}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <select
          className={`${INPUT} border font-semibold ${estiloEstado(a?.estado ?? null)}`}
          value={a?.estado ?? ""}
          disabled={!puedeEditar || guardando}
          onChange={(ev) => ev.target.value && onGuardar({ estado: ev.target.value })}
          aria-label={`Estado de ${e.nombre}`}
        >
          <option value="">Sin marcar</option>
          {ESTADOS.map((x) => (
            <option key={x.valor} value={x.valor}>
              {x.etiqueta}
            </option>
          ))}
        </select>
        {a?.estado === "ausente" ? (
          <select
            className={`${INPUT} mt-1 block text-xs ${a.justificada ? "text-emerald-700" : "text-rose-700"}`}
            value={a.justificada == null ? "" : a.justificada ? "si" : "no"}
            disabled={!puedeEditar || guardando}
            onChange={(ev) => onGuardar({ justificada: ev.target.value === "" ? null : ev.target.value === "si" })}
            aria-label={`Ausencia de ${e.nombre} justificada`}
          >
            <option value="">¿Justificada?</option>
            <option value="si">Justificada</option>
            <option value="no">Injustificada</option>
          </select>
        ) : null}
      </td>
      <td className="px-3 py-2.5">
        {conHoras ? (
          <div className="flex items-center gap-1.5">
            <input
              type="time"
              className={INPUT}
              value={entrada}
              disabled={!puedeEditar || guardando}
              onChange={(ev) => setEntrada(ev.target.value)}
              onBlur={() => entrada !== (a?.entrada ?? "") && onGuardar({ entrada: entrada || null })}
              aria-label={`Entrada de ${e.nombre}`}
            />
            {puedeEditar && esHoy && !a?.entrada ? (
              <button type="button" className={BTN_GHOST} disabled={guardando} onClick={() => onGuardar({ entrada: ahoraPY().hora })}>
                Ahora
              </button>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {conHoras ? (
          <div className="flex items-center gap-1.5">
            <input
              type="time"
              className={INPUT}
              value={salida}
              disabled={!puedeEditar || guardando || !a?.entrada}
              onChange={(ev) => setSalida(ev.target.value)}
              onBlur={() => salida !== (a?.salida ?? "") && onGuardar({ salida: salida || null })}
              aria-label={`Salida de ${e.nombre}`}
              title={!a?.entrada ? "Primero marcá la entrada" : undefined}
            />
            {puedeEditar && esHoy && a?.entrada && !a?.salida ? (
              <button type="button" className={BTN_GHOST} disabled={guardando} onClick={() => onGuardar({ salida: ahoraPY().hora })}>
                Ahora
              </button>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <input
          type="text"
          className={`${INPUT} w-full min-w-[10rem]`}
          value={obs}
          placeholder={puedeEditar ? "Opcional" : ""}
          disabled={!puedeEditar || guardando || !a}
          title={!a ? "Primero marcá el estado o la entrada" : undefined}
          onChange={(ev) => setObs(ev.target.value)}
          onBlur={() => obs !== (a?.observacion ?? "") && onGuardar({ observacion: obs })}
          maxLength={300}
        />
      </td>
    </tr>
  );
}

// ─── Resumen del mes ──────────────────────────────────────────────────────

function ResumenMes({ esAdmin }: { esAdmin: boolean }) {
  const [mes, setMes] = useState(() => ahoraPY().mes);
  const [filas, setFilas] = useState<Resumen[]>([]);
  const [liq, setLiq] = useState<Liquidacion[] | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setCargando(true);
    setError(null);
    setLiq(null);
    pedir<{ resumen: Resumen[] }>(`/api/rrhh/asistencia/resumen?mes=${mes}`)
      .then((d) => !cancel && setFilas(d.resumen))
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancel && setCargando(false));
    if (esAdmin) {
      pedir<{ filas: Liquidacion[] }>(`/api/rrhh/asistencia/liquidacion?mes=${mes}`)
        .then((d) => !cancel && setLiq(d.filas))
        .catch(() => null);
    }
    return () => {
      cancel = true;
    };
  }, [mes, esAdmin]);

  async function descargar() {
    const r = await apiFetch(`/api/rrhh/asistencia/liquidacion?mes=${mes}&formato=csv`);
    if (!r.ok) return setError("No se pudo generar el archivo.");
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `liquidacion-${mes}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const gs = (n: number) => n.toLocaleString("es-PY");

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="text-sm text-slate-600" htmlFor="mes-asistencia">Mes</label>
          <input id="mes-asistencia" type="month" className={INPUT} value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} />
          <span className="text-xs text-slate-400">
            Horas extra: lo trabajado después de la hora de salida de cada empleado.
          </span>
        </div>
        {error ? <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-3 py-2.5">Empleado</th>
                <th className="px-3 py-2.5 text-center">Trabajados</th>
                <th className="px-3 py-2.5 text-center">Tarde</th>
                <th className="px-3 py-2.5 text-center">Aus. justif.</th>
                <th className="px-3 py-2.5 text-center">Aus. injustif.</th>
                <th className="px-3 py-2.5 text-center">Permiso</th>
                <th className="px-3 py-2.5 text-center">Vacac.</th>
                <th className="px-3 py-2.5 text-center">Reposo</th>
                <th className="px-3 py-2.5 text-right">Horas</th>
                <th className="px-3 py-2.5 text-right">Extra</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cargando ? (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">Cargando…</td></tr>
              ) : filas.length === 0 && !error ? (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-500">Sin empleados ni registros en este mes.</td></tr>
              ) : (
                filas.map((r) => (
                  <tr key={r.empleado_id}>
                    <td className="px-3 py-2.5">
                      <span className="block font-medium text-slate-800">{r.nombre}</span>
                      {r.cargo ? <span className="block text-xs text-slate-400">{r.cargo}</span> : null}
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums">{r.presente + r.tarde}</td>
                    <td className={`px-3 py-2.5 text-center tabular-nums ${r.tarde ? "font-semibold text-amber-700" : "text-slate-300"}`}>{r.tarde}</td>
                    <td className={`px-3 py-2.5 text-center tabular-nums ${r.ausente_justificada ? "" : "text-slate-300"}`}>{r.ausente_justificada}</td>
                    <td className={`px-3 py-2.5 text-center tabular-nums ${r.ausente_injustificada ? "font-semibold text-rose-600" : "text-slate-300"}`}>{r.ausente_injustificada}</td>
                    <td className={`px-3 py-2.5 text-center tabular-nums ${r.permiso ? "" : "text-slate-300"}`}>{r.permiso}</td>
                    <td className={`px-3 py-2.5 text-center tabular-nums ${r.vacaciones ? "" : "text-slate-300"}`}>{r.vacaciones}</td>
                    <td className={`px-3 py-2.5 text-center tabular-nums ${r.reposo ? "" : "text-slate-300"}`}>{r.reposo}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {horas(r.minutos)}
                      {r.sin_salida > 0 ? <span className="block text-[11px] text-amber-700">{r.sin_salida} día{r.sin_salida === 1 ? "" : "s"} sin salida</span> : null}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${r.minutos_extra ? "font-semibold text-[#3F8E91]" : "text-slate-300"}`}>
                      {r.minutos_extra ? horas(r.minutos_extra) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {esAdmin && liq ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-700">Liquidación de referencia</h2>
              <p className="text-xs text-slate-500">
                Mensual: descuenta las ausencias injustificadas. Jornal: paga los días trabajados. Extra con 50% de recargo.
                Comisión: % sobre lo vendido en el mes como vendedor elegido en la Caja.
                IPS 9% trabajador y 16,5% empleador. Aguinaldo: 1/12 del bruto. La revisa el contador antes de pagar.
              </p>
            </div>
            <button type="button" className={BTN_PRIMARY} onClick={() => void descargar()}>
              Descargar para Excel
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                <tr>
                  <th className="px-3 py-2.5">Empleado</th>
                  <th className="px-3 py-2.5 text-right">Base</th>
                  <th className="px-3 py-2.5 text-right">Desc. ausencias</th>
                  <th className="px-3 py-2.5 text-right">Extras</th>
                  <th className="px-3 py-2.5 text-right">Comisión</th>
                  <th className="px-3 py-2.5 text-right">Bruto</th>
                  <th className="px-3 py-2.5 text-right">IPS 9%</th>
                  <th className="px-3 py-2.5 text-right">Neto</th>
                  <th className="px-3 py-2.5 text-right">IPS empleador</th>
                  <th className="px-3 py-2.5 text-right">Aguinaldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {liq.map((f) => (
                  <tr key={f.empleado_id}>
                    <td className="px-3 py-2.5">
                      <span className="block font-medium text-slate-800">{f.nombre}</span>
                      <span className="block text-xs text-slate-400">
                        {f.tipo_remuneracion === "jornal" ? "Jornal" : "Mensual"}
                        {f.aviso ? <span className="ml-1 text-amber-700">· {f.aviso}</span> : null}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{gs(f.monto_base)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${f.descuento_ausencias ? "text-rose-600" : "text-slate-300"}`}>
                      {f.descuento_ausencias ? `−${gs(f.descuento_ausencias)}` : "—"}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${f.monto_extras ? "" : "text-slate-300"}`}>{f.monto_extras ? gs(f.monto_extras) : "—"}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${f.monto_comision ? "" : "text-slate-300"}`}>{f.monto_comision ? gs(f.monto_comision) : "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{gs(f.bruto)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">−{gs(f.ips_obrero)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{gs(f.neto)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{gs(f.ips_patronal)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{gs(f.aguinaldo_provision)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ─── Vacaciones y reposos ─────────────────────────────────────────────────

type Saldo = {
  empleado_id: string;
  nombre: string;
  fecha_ingreso: string | null;
  antiguedad_anios: number | null;
  dias_que_corresponden: number | null;
  dias_tomados_anio: number;
  dias_reposo_anio: number;
};

function Vacaciones({ puedeEditar }: { puedeEditar: boolean }) {
  const anio = Number(ahoraPY().fecha.slice(0, 4));
  const [saldos, setSaldos] = useState<Saldo[]>([]);
  const [f, setF] = useState({ empleado_id: "", estado: "vacaciones", desde: ahoraPY().fecha, hasta: ahoraPY().fecha, observacion: "", justificada: true });
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setSaldos((await pedir<{ saldos: Saldo[] }>(`/api/rrhh/asistencia/vacaciones?anio=${anio}`)).saldos);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [anio]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar() {
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const d = await pedir<{ dias: number }>("/api/rrhh/asistencia/rango", { method: "POST", body: JSON.stringify(f) });
      setAviso(`Cargados ${d.dias} día${d.dias === 1 ? "" : "s"}.`);
      void cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-5">
      {puedeEditar ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Cargar un período</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <select className={INPUT} value={f.empleado_id} onChange={(e) => setF((x) => ({ ...x, empleado_id: e.target.value }))} aria-label="Empleado">
              <option value="">Empleado…</option>
              {saldos.map((s) => <option key={s.empleado_id} value={s.empleado_id}>{s.nombre}</option>)}
            </select>
            <select className={INPUT} value={f.estado} onChange={(e) => setF((x) => ({ ...x, estado: e.target.value }))} aria-label="Tipo">
              <option value="vacaciones">Vacaciones</option>
              <option value="reposo">Reposo</option>
              <option value="permiso">Permiso</option>
              <option value="ausente">Ausencia</option>
            </select>
            <input type="date" className={INPUT} value={f.desde} onChange={(e) => setF((x) => ({ ...x, desde: e.target.value }))} aria-label="Desde" />
            <input type="date" className={INPUT} value={f.hasta} onChange={(e) => setF((x) => ({ ...x, hasta: e.target.value }))} aria-label="Hasta" />
            <input className={INPUT} placeholder="Observación" value={f.observacion} onChange={(e) => setF((x) => ({ ...x, observacion: e.target.value }))} />
          </div>
          {f.estado === "ausente" ? (
            <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={f.justificada} onChange={(e) => setF((x) => ({ ...x, justificada: e.target.checked }))} />
              Ausencia justificada
            </label>
          ) : null}
          {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
          {aviso ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{aviso}</p> : null}
          <button type="button" className={`${BTN_PRIMARY} mt-3`} disabled={guardando || !f.empleado_id} onClick={() => void guardar()}>
            {guardando ? "Guardando…" : "Cargar período"}
          </button>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold text-slate-700">Vacaciones {anio}</h2>
        <p className="mb-3 text-xs text-slate-500">
          Por antigüedad: 12 días hasta 5 años, 18 de 5 a 10, 30 desde 10 (se ganan al cumplir el primer año). Hace falta la
          fecha de ingreso de cada empleado.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            <tr>
              <th className="py-2">Empleado</th>
              <th className="py-2">Ingreso</th>
              <th className="py-2 text-center">Le corresponden</th>
              <th className="py-2 text-center">Tomados</th>
              <th className="py-2 text-center">Quedan</th>
              <th className="py-2 text-center">Reposo (días)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {saldos.map((s) => {
              const quedan = s.dias_que_corresponden == null ? null : s.dias_que_corresponden - s.dias_tomados_anio;
              return (
                <tr key={s.empleado_id}>
                  <td className="py-2 font-medium text-slate-800">{s.nombre}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {s.fecha_ingreso ? `${new Date(`${s.fecha_ingreso}T12:00:00`).toLocaleDateString("es-PY")} (${s.antiguedad_anios} años)` : "Sin cargar"}
                  </td>
                  <td className="py-2 text-center tabular-nums">{s.dias_que_corresponden ?? "—"}</td>
                  <td className="py-2 text-center tabular-nums">{s.dias_tomados_anio}</td>
                  <td className={`py-2 text-center tabular-nums ${quedan != null && quedan < 0 ? "font-semibold text-rose-600" : ""}`}>{quedan ?? "—"}</td>
                  <td className="py-2 text-center tabular-nums">{s.dias_reposo_anio}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ─── Empleados ────────────────────────────────────────────────────────────

const VACIO = {
  nombre: "", documento: "", cargo: "", telefono: "", horario_entrada: "", horario_salida: "",
  salario_base: "", tipo_remuneracion: "mensual", fecha_ingreso: "", aporta_ips: "si", comision_pct: "",
};

function Empleados({ puedeEditar }: { puedeEditar: boolean }) {
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(VACIO);
  const [editId, setEditId] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const d = await pedir<{ empleados: Empleado[] }>("/api/rrhh/empleados?todos=1");
      setEmpleados(d.empleados);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      await pedir(editId ? `/api/rrhh/empleados/${editId}` : "/api/rrhh/empleados", {
        method: editId ? "PATCH" : "POST",
        body: JSON.stringify({ ...form, aporta_ips: form.aporta_ips === "si" }),
      });
      setForm(VACIO);
      setEditId(null);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }

  async function alternarActivo(emp: Empleado) {
    setError(null);
    try {
      await pedir(`/api/rrhh/empleados/${emp.id}`, { method: "PATCH", body: JSON.stringify({ activo: !emp.activo }) });
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function editar(emp: Empleado) {
    setEditId(emp.id);
    setForm({
      nombre: emp.nombre,
      documento: emp.documento ?? "",
      cargo: emp.cargo ?? "",
      telefono: emp.telefono ?? "",
      horario_entrada: emp.horario_entrada ?? "",
      horario_salida: emp.horario_salida ?? "",
      salario_base: emp.salario_base != null ? String(emp.salario_base) : "",
      tipo_remuneracion: emp.tipo_remuneracion ?? "mensual",
      fecha_ingreso: emp.fecha_ingreso ?? "",
      aporta_ips: emp.aporta_ips === false ? "no" : "si",
      comision_pct: emp.comision_pct != null ? String(emp.comision_pct) : "",
    });
  }

  const campo = (k: keyof typeof VACIO, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500" htmlFor={`emp-${k}`}>
        {label}
      </label>
      <input
        id={`emp-${k}`}
        className={`${INPUT} w-full`}
        value={form[k]}
        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
        {...extra}
      />
    </div>
  );

  return (
    <div className="space-y-5">
      {puedeEditar ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">{editId ? "Editar empleado" : "Nuevo empleado"}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {campo("nombre", "Nombre *", { placeholder: "Ej: JUAN PÉREZ" })}
            {campo("documento", "Cédula", { placeholder: "Ej: 4567890" })}
            {campo("cargo", "Cargo", { placeholder: "Ej: Panadero" })}
            {campo("telefono", "Teléfono")}
            {campo("horario_entrada", "Hora de entrada", { type: "time" })}
            {campo("horario_salida", "Hora de salida", { type: "time" })}
            {campo("fecha_ingreso", "Fecha de ingreso", { type: "date" })}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500" htmlFor="emp-tipo">
                Remuneración
              </label>
              <select id="emp-tipo" className={`${INPUT} w-full`} value={form.tipo_remuneracion}
                onChange={(e) => setForm((f) => ({ ...f, tipo_remuneracion: e.target.value }))}>
                <option value="mensual">Mensual</option>
                <option value="jornal">Jornal (por día)</option>
              </select>
            </div>
            {campo("salario_base", form.tipo_remuneracion === "jornal" ? "Jornal diario (Gs.)" : "Salario mensual (Gs.)", { inputMode: "numeric" })}
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500" htmlFor="emp-ips">
                IPS
              </label>
              <select id="emp-ips" className={`${INPUT} w-full`} value={form.aporta_ips}
                onChange={(e) => setForm((f) => ({ ...f, aporta_ips: e.target.value }))}>
                <option value="si">Aporta al IPS</option>
                <option value="no">No aporta</option>
              </select>
            </div>
            {campo("comision_pct", "Comisión de ventas (%)", { inputMode: "decimal", placeholder: "Solo vendedores" })}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Con la hora de entrada, la planilla marca &ldquo;Tarde&rdquo; sola a quien llega más de 10 minutos después.
            Con comisión cargada, el empleado aparece como vendedor en la Caja; no necesita cuenta en el sistema.
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" className={BTN_PRIMARY} disabled={guardando || !form.nombre.trim()} onClick={() => void guardar()}>
              {guardando ? "Guardando…" : editId ? "Guardar cambios" : "Agregar empleado"}
            </button>
            {editId ? (
              <button
                type="button"
                className={BTN_GHOST}
                onClick={() => {
                  setEditId(null);
                  setForm(VACIO);
                }}
              >
                Cancelar
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {puedeEditar ? <ImportarHistorial onListo={() => void cargar()} /> : null}

      {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-3 py-2.5">Nombre</th>
                <th className="px-3 py-2.5">Cédula</th>
                <th className="px-3 py-2.5">Cargo</th>
                <th className="px-3 py-2.5">Horario</th>
                <th className="px-3 py-2.5">Estado</th>
                {puedeEditar ? <th className="px-3 py-2.5">Acciones</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cargando ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-slate-400">Cargando…</td>
                </tr>
              ) : empleados.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-slate-500">Todavía no hay empleados.</td>
                </tr>
              ) : (
                empleados.map((emp) => (
                  <tr key={emp.id} className={emp.activo ? "" : "text-slate-400"}>
                    <td className="px-3 py-2.5 font-medium">{emp.nombre}</td>
                    <td className="px-3 py-2.5">{emp.documento ?? "—"}</td>
                    <td className="px-3 py-2.5">{emp.cargo ?? "—"}</td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {emp.horario_entrada || emp.horario_salida
                        ? `${emp.horario_entrada ?? "?"} – ${emp.horario_salida ?? "?"}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          emp.activo ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {emp.activo ? "Activo" : "De baja"}
                      </span>
                    </td>
                    {puedeEditar ? (
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1.5">
                          <button type="button" className={BTN_GHOST} onClick={() => editar(emp)}>
                            Editar
                          </button>
                          <button type="button" className={BTN_GHOST} onClick={() => void alternarActivo(emp)}>
                            {emp.activo ? "Dar de baja" : "Reactivar"}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Dar de baja saca al empleado de la planilla diaria pero conserva su historial de asistencia.
        </p>
      </section>
    </div>
  );
}

// ─── Importar historial ───────────────────────────────────────────────────

type ResultadoImport = { filas: number; importadas: number; empleados_creados: string[]; errores: { fila: number; motivo: string }[] };

const PLANTILLA =
  "EMPLEADO;CEDULA;FECHA;ENTRADA;SALIDA;ESTADO;JUSTIFICADA;OBSERVACION\r\n" +
  "JUAN PEREZ;4567890;01/10/2026;05:00;13:10;;;\r\n" +
  "JUAN PEREZ;4567890;02/10/2026;;;ausente;si;Médico\r\n" +
  "ANA GOMEZ;3456789;01/10/2026;06:20;14:00;;;\r\n";

/** Importa la asistencia que hoy está en Excel. Volver a importar no duplica. */
function ImportarHistorial({ onListo }: { onListo: () => void }) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [crear, setCrear] = useState(true);
  const [res, setRes] = useState<ResultadoImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);

  function bajarPlantilla() {
    const url = URL.createObjectURL(new Blob(["\uFEFF" + PLANTILLA], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "plantilla-asistencia.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importar() {
    if (!archivo) return;
    setSubiendo(true);
    setError(null);
    setRes(null);
    try {
      const fd = new FormData();
      fd.append("archivo", archivo);
      fd.append("crear_empleados", crear ? "1" : "0");
      const r = await apiFetch("/api/rrhh/asistencia/importar", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: ResultadoImport };
      if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
      setRes(j.data!);
      onListo();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">Importar historial desde Excel</h2>
      <p className="mt-1 text-xs text-slate-500">
        Una fila por empleado y día con las columnas EMPLEADO, CEDULA, FECHA, ENTRADA, SALIDA y, si hace falta, ESTADO,
        JUSTIFICADA y OBSERVACION. Volver a importar el mismo archivo actualiza, no duplica.{" "}
        <button type="button" className="font-semibold text-[#3F8E91] hover:underline" onClick={bajarPlantilla}>
          Bajar plantilla de ejemplo
        </button>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
          className="text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-semibold"
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={crear} onChange={(e) => setCrear(e.target.checked)} />
          Crear los empleados que no existan
        </label>
        <button type="button" className={BTN_PRIMARY} disabled={!archivo || subiendo} onClick={() => void importar()}>
          {subiendo ? "Importando…" : "Importar"}
        </button>
      </div>
      {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      {res ? (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <p>
            <strong>{res.importadas}</strong> de {res.filas} filas importadas
            {res.empleados_creados.length > 0 ? ` · empleados nuevos: ${res.empleados_creados.join(", ")}` : ""}.
          </p>
          {res.errores.length > 0 ? (
            <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-rose-700">
              {res.errores.slice(0, 50).map((e) => <li key={e.fila}>Fila {e.fila}: {e.motivo}</li>)}
              {res.errores.length > 50 ? <li>… y {res.errores.length - 50} más</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
