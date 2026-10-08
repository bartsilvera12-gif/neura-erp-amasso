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
};

type Fila = {
  empleado: Empleado;
  asistencia: { id: string; estado: Estado; entrada: string | null; salida: string | null; observacion: string | null } | null;
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
  const [vista, setVista] = useState<"planilla" | "resumen" | "empleados">("planilla");
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
          { id: "resumen", label: "Resumen del mes" },
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
      {vista === "resumen" ? <ResumenMes /> : null}
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

function ResumenMes() {
  const [mes, setMes] = useState(() => ahoraPY().mes);
  const [filas, setFilas] = useState<Resumen[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setCargando(true);
    setError(null);
    pedir<{ resumen: Resumen[] }>(`/api/rrhh/asistencia/resumen?mes=${mes}`)
      .then((d) => !cancel && setFilas(d.resumen))
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancel && setCargando(false));
    return () => {
      cancel = true;
    };
  }, [mes]);

  const cols: { k: keyof Resumen; label: string }[] = [
    { k: "presente", label: "Presente" },
    { k: "tarde", label: "Tarde" },
    { k: "ausente", label: "Ausente" },
    { k: "permiso", label: "Permiso" },
    { k: "vacaciones", label: "Vacac." },
    { k: "reposo", label: "Reposo" },
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-600" htmlFor="mes-asistencia">
          Mes
        </label>
        <input id="mes-asistencia" type="month" className={INPUT} value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} />
        <span className="text-xs text-slate-400">Las horas cuentan solo los días con entrada y salida.</span>
      </div>
      {error ? <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            <tr>
              <th className="px-3 py-2.5">Empleado</th>
              {cols.map((c) => (
                <th key={c.k} className="px-3 py-2.5 text-center">
                  {c.label}
                </th>
              ))}
              <th className="px-3 py-2.5 text-right">Horas trabajadas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {cargando ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-slate-400">Cargando…</td>
              </tr>
            ) : filas.length === 0 && !error ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-slate-500">Sin empleados ni registros en este mes.</td>
              </tr>
            ) : (
              filas.map((r) => (
                <tr key={r.empleado_id}>
                  <td className="px-3 py-2.5">
                    <span className="block font-medium text-slate-800">{r.nombre}</span>
                    {r.cargo ? <span className="block text-xs text-slate-400">{r.cargo}</span> : null}
                  </td>
                  {cols.map((c) => (
                    <td
                      key={c.k}
                      className={`px-3 py-2.5 text-center tabular-nums ${
                        Number(r[c.k]) === 0 ? "text-slate-300" : c.k === "ausente" || c.k === "tarde" ? "font-semibold text-rose-600" : "text-slate-700"
                      }`}
                    >
                      {r[c.k] as number}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {horas(r.minutos)}
                    {r.sin_salida > 0 ? (
                      <span className="block text-[11px] text-amber-700">
                        {r.sin_salida} día{r.sin_salida === 1 ? "" : "s"} sin salida
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Empleados ────────────────────────────────────────────────────────────

const VACIO = { nombre: "", documento: "", cargo: "", telefono: "", horario_entrada: "", horario_salida: "" };

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
        body: JSON.stringify(form),
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
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Con la hora de entrada, la planilla marca &ldquo;Tarde&rdquo; sola a quien llega más de 10 minutos después.
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
