"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import { useIsAdmin } from "@/lib/auth/use-is-admin";
import { CONFIG_RRHH_DEFECTO, type AccesoModulo, type ConfigRrhh } from "@/lib/rrhh/config-tipos";

/**
 * RRHH › Configuración. Las decisiones del punto 6 de la especificación de
 * Amasso, para que las ajuste el administrador sin tocar código: módulos
 * restringidos, horario, descansos, excepciones, PIN y dispositivos.
 */

type Respuesta = { config: ConfigRrhh; modificada: { cuando: string; quien: string | null } | null };

const INPUT =
  "w-24 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm tabular-nums text-slate-800 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 disabled:bg-slate-50 disabled:text-slate-400";

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T };
  if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
  return j.data as T;
}

// ─── Controles ────────────────────────────────────────────────────────────

function Opciones<T extends string>({
  valor,
  opciones,
  onChange,
  etiqueta,
}: {
  valor: T;
  opciones: { v: T; t: string; d?: string }[];
  onChange: (v: T) => void;
  etiqueta: string;
}) {
  return (
    <div role="radiogroup" aria-label={etiqueta} className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
      {opciones.map((o) => {
        const activo = o.v === valor;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={activo}
            onClick={() => onChange(o.v)}
            className={`rounded-xl border px-3 py-2.5 text-left transition ${
              activo
                ? "border-[#4FAEB2] bg-[#4FAEB2]/10 shadow-[0_0_0_1px_#4FAEB2]"
                : "border-slate-200 bg-white hover:border-slate-300"
            }`}
          >
            <span className={`flex items-center gap-2 text-sm font-semibold ${activo ? "text-[#2F7A7D]" : "text-slate-700"}`}>
              <span
                aria-hidden="true"
                className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${activo ? "border-[#3F8E91]" : "border-slate-300"}`}
              >
                {activo ? <span className="h-2 w-2 rounded-full bg-[#3F8E91]" /> : null}
              </span>
              {o.t}
            </span>
            {o.d ? <span className="mt-0.5 block pl-6 text-xs text-slate-500">{o.d}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Interruptor({
  valor,
  onChange,
  titulo,
  detalle,
}: {
  valor: boolean;
  onChange: (v: boolean) => void;
  titulo: string;
  detalle?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl px-1 py-1">
      <span>
        <span className="block text-sm font-medium text-slate-800">{titulo}</span>
        {detalle ? <span className="block text-xs text-slate-500">{detalle}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={valor}
        aria-label={titulo}
        onClick={() => onChange(!valor)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${valor ? "bg-[#3F8E91]" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${valor ? "left-[1.375rem]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

/** Número opcional: vacío = sin límite. Guarda texto para no pelear con el cursor. */
function Numero({
  valor,
  onChange,
  sufijo,
  vacio,
  min = 0,
  max = 999,
  id,
}: {
  valor: number | null;
  onChange: (v: number | null) => void;
  sufijo: string;
  vacio?: string;
  min?: number;
  max?: number;
  id: string;
}) {
  const [txt, setTxt] = useState(valor == null ? "" : String(valor));
  useEffect(() => setTxt(valor == null ? "" : String(valor)), [valor]);
  return (
    <span className="inline-flex items-center gap-2">
      <input
        id={id}
        inputMode="numeric"
        className={INPUT}
        value={txt}
        placeholder={vacio ?? ""}
        onChange={(e) => {
          const s = e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 3);
          setTxt(s);
          if (s === "") onChange(vacio != null ? null : min);
          else onChange(Math.min(max, Math.max(min, Number(s))));
        }}
        onBlur={() => setTxt(valor == null ? "" : String(valor))}
      />
      <span className="text-sm text-slate-500">{sufijo}</span>
    </span>
  );
}

function Seccion({
  n,
  titulo,
  pregunta,
  children,
}: {
  n: number;
  titulo: string;
  pregunta: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#4FAEB2]/12 font-mono text-sm font-semibold text-[#2F7A7D]">
          {n}
        </span>
        <div>
          <h2 className="text-base font-semibold text-slate-900">{titulo}</h2>
          <p className="text-xs text-slate-500">{pregunta}</p>
        </div>
      </header>
      <div className="space-y-5 px-5 py-4">{children}</div>
    </section>
  );
}

const Campo = ({ titulo, detalle, children }: { titulo: string; detalle?: string; children: React.ReactNode }) => (
  <div>
    <p className="text-sm font-medium text-slate-800">{titulo}</p>
    {detalle ? <p className="mb-2 text-xs text-slate-500">{detalle}</p> : <div className="mb-2" />}
    {children}
  </div>
);

const ACCESOS: { v: AccesoModulo; t: string; d: string }[] = [
  { v: "nadie", t: "Oculto para todos", d: "Nadie lo ve ni entra, tampoco el administrador." },
  { v: "admin", t: "Solo administradores", d: "Los demás no lo ven y si escriben la dirección, no entran." },
  { v: "todos", t: "Visible para todos", d: "Aparece en el menú de todos los usuarios." },
];

// ─── Página ───────────────────────────────────────────────────────────────

export default function ConfiguracionRrhhPage() {
  const { isAdmin, loaded } = useIsAdmin();
  const [guardada, setGuardada] = useState<ConfigRrhh | null>(null);
  const [cfg, setCfg] = useState<ConfigRrhh | null>(null);
  const [modificada, setModificada] = useState<Respuesta["modificada"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded || !isAdmin) return;
    pedir<Respuesta>("/api/rrhh/configuracion")
      .then((d) => {
        setGuardada(d.config);
        setCfg(d.config);
        setModificada(d.modificada);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [loaded, isAdmin]);

  const cambios = useMemo(() => !!cfg && !!guardada && JSON.stringify(cfg) !== JSON.stringify(guardada), [cfg, guardada]);
  const esDefecto = useMemo(() => !!cfg && JSON.stringify(cfg) === JSON.stringify(CONFIG_RRHH_DEFECTO), [cfg]);

  /** Cambia un valor dentro de una sección. */
  function set<S extends keyof ConfigRrhh, K extends keyof ConfigRrhh[S]>(seccion: S, clave: K, valor: ConfigRrhh[S][K]) {
    setCfg((c) => (c ? { ...c, [seccion]: { ...c[seccion], [clave]: valor } } : c));
    setAviso(null);
  }

  async function guardar() {
    if (!cfg) return;
    setGuardando(true);
    setError(null);
    try {
      const d = await pedir<Respuesta>("/api/rrhh/configuracion", { method: "PUT", body: JSON.stringify({ config: cfg }) });
      setGuardada(d.config);
      setCfg(d.config);
      setModificada(d.modificada);
      setAviso("Configuración guardada. Ya rige para las próximas marcaciones.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }

  const urlTerminal = typeof window !== "undefined" ? `${window.location.origin}/terminal-asistencia` : "/terminal-asistencia";

  if (loaded && !isAdmin) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="font-semibold text-slate-800">Solo un administrador puede ver la configuración de RRHH.</p>
        <Link href="/usuarios/asistencia" className="mt-3 inline-block text-sm font-semibold text-[#3F8E91] hover:underline">
          Volver a Empleados y asistencia
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 pb-28">
      <div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">RRHH</p>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Configuración</h1>
        <p className="mt-1 text-sm text-slate-500">
          Cómo funciona la marcación de asistencia y quién ve los módulos restringidos. Cada cambio rige desde que lo guardás.
          {modificada ? (
            <span className="block text-xs text-slate-400">
              Último cambio: {modificada.cuando}
              {modificada.quien ? ` · ${modificada.quien}` : ""}
            </span>
          ) : (
            <span className="block text-xs text-slate-400">Usando los valores por defecto.</span>
          )}
        </p>
      </div>

      {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      {!cfg && !error ? <p className="py-10 text-center text-sm text-slate-400">Cargando…</p> : null}

      {cfg ? (
        <>
          <Seccion n={1} titulo="Módulos restringidos" pregunta="¿Para todos los perfiles o solo operativos? ¿El administrador conserva acceso?">
            <Campo titulo="Gestión Clientes">
              <Opciones etiqueta="Gestión Clientes" valor={cfg.modulos.gestion_clientes} opciones={ACCESOS} onChange={(v) => set("modulos", "gestion_clientes", v)} />
            </Campo>
            <Campo titulo="Bancos" detalle="Quien no tiene acceso igual ve los nombres de los bancos en los desplegables de cobros, sin números de cuenta ni titulares.">
              <Opciones etiqueta="Bancos" valor={cfg.modulos.bancos} opciones={ACCESOS} onChange={(v) => set("modulos", "bancos", v)} />
            </Campo>
          </Seccion>

          <Seccion n={2} titulo="Horario de trabajo" pregunta="¿Turnos fijos o rotativos, marcaciones nocturnas y tolerancia por tardanza?">
            <Campo titulo="Tipo de horario">
              <Opciones
                etiqueta="Tipo de horario"
                valor={cfg.horario.modo}
                onChange={(v) => set("horario", "modo", v)}
                opciones={[
                  { v: "fijo", t: "Fijo por empleado", d: "Cada uno tiene su hora de entrada; si llega tarde, se marca Tarde." },
                  { v: "libre", t: "Libre o rotativo", d: "Los turnos cambian: no se calcula llegada tarde." },
                ]}
              />
            </Campo>
            {cfg.horario.modo === "fijo" ? (
              <Campo titulo="Tolerancia para llegar tarde" detalle="Minutos de gracia después de la hora de entrada.">
                <Numero id="cf-tol" valor={cfg.horario.tolerancia_min} onChange={(v) => set("horario", "tolerancia_min", v ?? 0)} sufijo="minutos" max={120} />
              </Campo>
            ) : null}
            <Interruptor
              valor={cfg.horario.jornada_nocturna}
              onChange={(v) => set("horario", "jornada_nocturna", v)}
              titulo="Permitir jornadas nocturnas"
              detalle="Una jornada puede empezar un día y terminar al siguiente (turnos de noche). Si está apagado, cada día empieza una jornada nueva."
            />
            {cfg.horario.jornada_nocturna ? (
              <Campo titulo="Duración máxima de una jornada" detalle="Pasado este tiempo sin salida, se considera que se olvidó de marcarla.">
                <Numero id="cf-hmax" valor={cfg.horario.horas_max_jornada} onChange={(v) => set("horario", "horas_max_jornada", v ?? 20)} sufijo="horas" min={4} max={36} />
              </Campo>
            ) : null}
          </Seccion>

          <Seccion n={3} titulo="Descansos" pregunta="¿Duración máxima y posibilidad de varios breaks? ¿Se descuentan del tiempo trabajado?">
            <div className="grid gap-5 sm:grid-cols-2">
              <Campo titulo="Breaks por jornada" detalle="Vacío = los que hagan falta.">
                <Numero id="cf-bmax" valor={cfg.descansos.breaks_max} onChange={(v) => set("descansos", "breaks_max", v)} sufijo="como máximo" vacio="Sin límite" max={20} />
              </Campo>
              <Campo titulo="Duración máxima de un break" detalle="Si se pasa, se avisa al marcar y queda registrado.">
                <Numero id="cf-bmin" valor={cfg.descansos.break_max_min} onChange={(v) => set("descansos", "break_max_min", v)} sufijo="minutos" vacio="Sin límite" min={1} max={600} />
              </Campo>
            </div>
            <Interruptor valor={cfg.descansos.almuerzo} onChange={(v) => set("descansos", "almuerzo", v)} titulo="Hay almuerzo" detalle="Uno por jornada. Si está apagado, el botón de almuerzo no aparece." />
            {cfg.descansos.almuerzo ? (
              <Campo titulo="Duración máxima del almuerzo">
                <Numero id="cf-amin" valor={cfg.descansos.almuerzo_max_min} onChange={(v) => set("descansos", "almuerzo_max_min", v)} sufijo="minutos" vacio="Sin límite" min={1} max={600} />
              </Campo>
            ) : null}
            <div className="rounded-xl bg-slate-50 px-3 py-2">
              <Interruptor valor={cfg.descansos.descontar_break} onChange={(v) => set("descansos", "descontar_break", v)} titulo="Descontar los breaks de las horas trabajadas" />
              <Interruptor valor={cfg.descansos.descontar_almuerzo} onChange={(v) => set("descansos", "descontar_almuerzo", v)} titulo="Descontar el almuerzo de las horas trabajadas" />
            </div>
          </Seccion>

          <Seccion n={4} titulo="Excepciones" pregunta="¿Qué hacer ante olvido de salida, jornada inconclusa, turnos de dos días o reingreso?">
            <Campo titulo="Salida con un break o almuerzo abierto">
              <Opciones
                etiqueta="Salida con pausa abierta"
                valor={cfg.excepciones.salida_con_pausa}
                onChange={(v) => set("excepciones", "salida_con_pausa", v)}
                opciones={[
                  { v: "cerrar_y_avisar", t: "Cerrar la pausa y avisar", d: "La pausa termina a la hora de la salida." },
                  { v: "bloquear", t: "No dejar", d: "Primero tiene que marcar el fin de la pausa." },
                ]}
              />
            </Campo>
            <Campo titulo="Olvido de salida">
              <Opciones
                etiqueta="Olvido de salida"
                valor={cfg.excepciones.olvido_salida}
                onChange={(v) => set("excepciones", "olvido_salida", v)}
                opciones={[
                  { v: "incompleta", t: "Queda incompleta", d: "Aparece en el aviso de Marcaciones y la corrige un administrador con motivo." },
                  { v: "cerrar_en_horario", t: "Se cierra sola a su hora de salida", d: "Queda registrada como corrección automática. Si el empleado no tiene hora de salida, queda incompleta." },
                ]}
              />
            </Campo>
            <Interruptor
              valor={cfg.excepciones.reingreso}
              onChange={(v) => set("excepciones", "reingreso", v)}
              titulo="Permitir reingreso el mismo día"
              detalle="Después de marcar la salida puede volver a marcar entrada (por ejemplo, horario cortado). El tiempo afuera no cuenta como trabajado."
            />
          </Seccion>

          <Seccion n={5} titulo="Autenticación de la marcación" pregunta="¿Cédula + código son suficientes o se añade PIN individual para evitar suplantación?">
            <Opciones
              etiqueta="PIN"
              valor={cfg.autenticacion.pin}
              onChange={(v) => set("autenticacion", "pin", v)}
              opciones={[
                { v: "desactivado", t: "Solo cédula y código", d: "No se pide PIN a nadie, aunque tenga uno cargado." },
                { v: "opcional", t: "PIN a quien tenga", d: "Se pide solo a los empleados con PIN cargado." },
                { v: "obligatorio", t: "PIN obligatorio", d: "Todos necesitan PIN. Quien no tenga no puede marcar." },
              ]}
            />
          </Seccion>

          <Seccion n={6} titulo="Dispositivos" pregunta="¿Solo desde una sesión ERP abierta, o también una terminal independiente?">
            <Interruptor
              valor={cfg.dispositivos.boton_en_barra}
              onChange={(v) => set("dispositivos", "boton_en_barra", v)}
              titulo="Botón «Marcar asistencia» en la barra"
              detalle="Desde cualquier sesión abierta del ERP, en todas las pantallas."
            />
            <Interruptor
              valor={cfg.dispositivos.terminal}
              onChange={(v) => set("dispositivos", "terminal", v)}
              titulo="Terminal de marcación"
              detalle="Una PC o tablet dedicada: muestra solo la pantalla de marcar, a pantalla completa, y no se cierra."
            />
            {cfg.dispositivos.terminal ? (
              <div className="rounded-xl border border-[#4FAEB2]/30 bg-[#4FAEB2]/5 px-4 py-3 text-sm">
                <p className="font-medium text-slate-800">Para usarla</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  En la PC de la entrada, iniciá sesión en el ERP y abrí esta dirección (guardala como favorito o página de inicio):
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded-lg bg-white px-2.5 py-1 font-mono text-xs text-slate-700 ring-1 ring-slate-200">{urlTerminal}</code>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    onClick={() => void navigator.clipboard?.writeText(urlTerminal).then(() => setAviso("Dirección copiada."))}
                  >
                    Copiar
                  </button>
                </div>
              </div>
            ) : null}
            {!cfg.dispositivos.boton_en_barra && !cfg.dispositivos.terminal ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Con las dos opciones apagadas nadie puede marcar asistencia.</p>
            ) : null}
            <p className="text-xs text-slate-400">El reloj de huella se va a conectar más adelante.</p>
          </Seccion>
        </>
      ) : null}

      {/* Barra de guardado */}
      {cfg ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur md:left-[260px]">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-4 py-3">
            <span className="text-sm text-slate-500">
              {aviso ? <span className="font-medium text-emerald-700">{aviso}</span> : cambios ? "Tenés cambios sin guardar." : "Sin cambios."}
            </span>
            <div className="ml-auto flex gap-2">
              {!esDefecto ? (
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  onClick={() => {
                    setCfg(CONFIG_RRHH_DEFECTO);
                    setAviso(null);
                  }}
                >
                  Valores por defecto
                </button>
              ) : null}
              {cambios ? (
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  onClick={() => setCfg(guardada)}
                >
                  Descartar
                </button>
              ) : null}
              <button
                type="button"
                disabled={!cambios || guardando}
                onClick={() => void guardar()}
                className="rounded-lg bg-[#3F8E91] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#357a7d] disabled:opacity-50"
              >
                {guardando ? "Guardando…" : "Guardar cambios"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
