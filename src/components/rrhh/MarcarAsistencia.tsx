"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clock } from "lucide-react";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";

/**
 * Botón "Marcar asistencia" de la barra de arriba y su pantalla.
 *
 * Lo usa cualquier empleado desde cualquier sesión abierta del ERP (la caja,
 * la PC de la fábrica): se identifica con cédula + código (y PIN si tiene),
 * elige qué marca y listo. La marcación queda a su nombre; la sesión no cambia.
 * La hora la pone el servidor. Al terminar, o a los pocos segundos, se borran
 * los datos para que el siguiente no vea nada del anterior.
 */

type TipoEvento = "entrada" | "inicio_break" | "fin_break" | "inicio_almuerzo" | "fin_almuerzo" | "salida";
type EstadoJornada = "sin_entrada" | "trabajando" | "en_break" | "en_almuerzo" | "cerrada";

type Identificado =
  | { requiere_pin: true }
  | { requiere_pin: false; nombre: string; estado: EstadoJornada; acciones: TipoEvento[]; aviso: string | null };

type Hecho = { nombre: string; tipo: TipoEvento; etiqueta: string; hora: string; aviso: string | null };

const ACCION: Record<TipoEvento, { titulo: string; icono: string; cls: string }> = {
  entrada: { titulo: "Entrada", icono: "→", cls: "bg-emerald-600 hover:bg-emerald-700 text-white" },
  inicio_break: { titulo: "Inicio de break", icono: "☕", cls: "bg-amber-500 hover:bg-amber-600 text-white" },
  fin_break: { titulo: "Fin de break", icono: "↩", cls: "bg-amber-600 hover:bg-amber-700 text-white" },
  inicio_almuerzo: { titulo: "Inicio de almuerzo", icono: "🍽", cls: "bg-sky-600 hover:bg-sky-700 text-white" },
  fin_almuerzo: { titulo: "Fin de almuerzo", icono: "↩", cls: "bg-sky-700 hover:bg-sky-800 text-white" },
  salida: { titulo: "Salida", icono: "←", cls: "bg-slate-800 hover:bg-slate-900 text-white" },
};

const ESTADO: Record<EstadoJornada, { texto: string; cls: string }> = {
  sin_entrada: { texto: "Todavía no marcaste la entrada", cls: "bg-slate-100 text-slate-600" },
  trabajando: { texto: "Trabajando", cls: "bg-emerald-50 text-emerald-700" },
  en_break: { texto: "En break", cls: "bg-amber-50 text-amber-800" },
  en_almuerzo: { texto: "En almuerzo", cls: "bg-sky-50 text-sky-700" },
  cerrada: { texto: "Ya marcaste la salida", cls: "bg-slate-100 text-slate-600" },
};

/** Segundos que queda a la vista la confirmación antes de limpiar todo. */
const SEG_CONFIRMACION = 8;
/** Si nadie toca nada en la pantalla de acciones, se limpia sola. */
const SEG_INACTIVIDAD = 45;

function horaPY(): string {
  return new Intl.DateTimeFormat("es-PY", { timeZone: "America/Asuncion", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
}

async function enviar<T>(url: string, body: unknown): Promise<T> {
  const r = await apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: T };
  if (!r.ok || !j.success) throw new Error(j.error ?? `Error ${r.status}`);
  return j.data as T;
}

export default function MarcarAsistencia() {
  const [abierto, setAbierto] = useState(false);
  // RRHH › Configuración puede sacar el botón de la barra (p. ej. si se marca
  // solo desde una terminal). Hasta saberlo no se muestra.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let cancel = false;
    apiFetch("/api/rrhh/configuracion/publica", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: { dispositivos?: { boton_en_barra?: boolean } } } | null) => {
        if (!cancel) setVisible(j?.data?.dispositivos?.boton_en_barra !== false);
      })
      .catch(() => !cancel && setVisible(true));
    return () => {
      cancel = true;
    };
  }, []);
  if (!visible) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="flex h-10 items-center gap-2 rounded-lg border border-[#4FAEB2]/40 bg-[#4FAEB2]/10 px-3 text-sm font-semibold text-[#2F7A7D] transition-colors hover:bg-[#4FAEB2]/20"
        title="Marcar entrada, break, almuerzo o salida"
      >
        <Clock className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">Marcar asistencia</span>
      </button>
      {/* Va directo al body: la barra de arriba tiene backdrop-blur, y eso
          encierra cualquier "fixed" de adentro en el alto de la barra. */}
      {abierto ? createPortal(<Pantalla onCerrar={() => setAbierto(false)} />, document.body) : null}
    </>
  );
}

/**
 * La pantalla de marcar. En modo terminal (una PC dedicada a marcar) no se
 * cierra nunca: al terminar o por inactividad vuelve a pedir los datos.
 */
export function Pantalla({ onCerrar, terminal = false }: { onCerrar: () => void; terminal?: boolean }) {
  const [cedula, setCedula] = useState("");
  const [codigo, setCodigo] = useState("");
  const [pin, setPin] = useState("");
  const [pidePin, setPidePin] = useState(false);
  const [ident, setIdent] = useState<Extract<Identificado, { requiere_pin: false }> | null>(null);
  const [hecho, setHecho] = useState<Hecho | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [reloj, setReloj] = useState(horaPY);
  const [cuenta, setCuenta] = useState(SEG_CONFIRMACION);
  const cedulaRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  // Al cerrar, nada queda en memoria del componente.
  function limpiar() {
    setCedula("");
    setCodigo("");
    setPin("");
    setPidePin(false);
    setIdent(null);
    setHecho(null);
    setError(null);
    setCuenta(SEG_CONFIRMACION);
  }
  function cerrar() {
    limpiar();
    if (!terminal) onCerrar();
    else setTimeout(() => cedulaRef.current?.focus(), 50);
  }

  useEffect(() => {
    const t = setInterval(() => setReloj(horaPY()), 1000);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !terminal && cerrar();
    window.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    cedulaRef.current?.focus();
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Confirmación: cuenta regresiva y se cierra sola.
  useEffect(() => {
    if (!hecho) return;
    if (cuenta <= 0) {
      cerrar();
      return;
    }
    const t = setTimeout(() => setCuenta((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hecho, cuenta]);

  // Pantalla de acciones abandonada: se limpia para que el próximo no marque por otro.
  useEffect(() => {
    if (!ident || hecho) return;
    const t = setTimeout(() => {
      limpiar();
      setError("Se cerró por inactividad. Volvé a ingresar tus datos.");
    }, SEG_INACTIVIDAD * 1000);
    return () => clearTimeout(t);
  }, [ident, hecho]);

  useEffect(() => {
    if (pidePin) pinRef.current?.focus();
  }, [pidePin]);

  const cred = () => ({ cedula, codigo, pin: pidePin ? pin : undefined });

  async function continuar(e: React.FormEvent) {
    e.preventDefault();
    setOcupado(true);
    setError(null);
    try {
      const r = await enviar<Identificado>("/api/rrhh/marcar/identificar", cred());
      if (r.requiere_pin) {
        setPidePin(true);
      } else {
        setIdent(r);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPin("");
    } finally {
      setOcupado(false);
    }
  }

  async function marcar(tipo: TipoEvento) {
    setOcupado(true);
    setError(null);
    try {
      const r = await enviar<Hecho>("/api/rrhh/marcar", { ...cred(), tipo });
      // Los datos de identificación se borran apenas se marcó.
      setCedula("");
      setCodigo("");
      setPin("");
      setIdent(null);
      setHecho(r);
      // Para que la planilla y las marcaciones abiertas se actualicen solas.
      window.dispatchEvent(new Event("rrhh:marcacion"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOcupado(false);
    }
  }

  const listoParaSeguir = cedula.trim().length >= 3 && codigo.trim().length >= 1 && (!pidePin || /^\d{4,6}$/.test(pin));

  return (
    <div
      className={`fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6 ${
        terminal ? "bg-gradient-to-br from-slate-900 to-[#163c3e]" : "bg-slate-900/60 backdrop-blur-sm"
      }`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Marcar asistencia"
        className="relative flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-3xl bg-white shadow-2xl"
      >
        {/* Cabecera con el reloj */}
        <div className="relative overflow-hidden rounded-t-3xl bg-gradient-to-br from-[#3F8E91] to-[#2B6E71] px-6 pb-6 pt-5 text-white">
          <div aria-hidden="true" className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
          <div aria-hidden="true" className="absolute -bottom-16 -left-8 h-36 w-36 rounded-full bg-white/5" />
          <div className="relative flex items-start justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/80">Marcar asistencia</p>
            {terminal ? (
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold text-white/90">Terminal</span>
            ) : (
              <button type="button" onClick={cerrar} className="-mr-2 -mt-1 rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white" aria-label="Cerrar">
                ✕
              </button>
            )}
          </div>
          <p className="relative mt-1 font-mono text-5xl font-semibold tabular-nums tracking-tight">{reloj}</p>
          <p className="relative mt-1 text-xs capitalize text-white/80">
            {new Date().toLocaleDateString("es-PY", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Asuncion" })}
            <span className="normal-case"> · la hora la registra el sistema</span>
          </p>
        </div>

        <div className="px-6 pb-6 pt-5">
          {hecho ? (
            <div className="py-2 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl text-emerald-600">✓</div>
              <p className="mt-3 text-sm text-slate-500">{hecho.nombre}</p>
              <p className="mt-0.5 text-xl font-semibold text-slate-900">
                {hecho.etiqueta} registrada a las <span className="tabular-nums">{hecho.hora}</span>
              </p>
              {hecho.aviso ? <p className="mx-auto mt-3 max-w-xs rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{hecho.aviso}</p> : null}
              <button type="button" onClick={cerrar} className="mt-5 w-full rounded-2xl bg-slate-900 py-3 text-sm font-semibold text-white hover:bg-slate-800">
                Listo
              </button>
              <p className="mt-2 text-xs text-slate-400">{terminal ? "Vuelve al inicio" : "Se cierra sola"} en {cuenta} s</p>
            </div>
          ) : ident ? (
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#4FAEB2]/15 text-lg font-semibold text-[#2F7A7D]">
                  {ident.nombre.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold text-slate-900">Hola, {ident.nombre.split(/\s+/)[0]}</p>
                  <span className={`mt-0.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${ESTADO[ident.estado].cls}`}>
                    {ESTADO[ident.estado].texto}
                  </span>
                </div>
              </div>
              {ident.aviso ? <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{ident.aviso}</p> : null}
              {ident.acciones.length > 0 ? (
                <>
                  <p className="mt-5 text-sm font-medium text-slate-600">¿Qué querés marcar?</p>
                  <div className={`mt-2 grid gap-2 ${ident.acciones.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                    {ident.acciones.map((a) => (
                      <button
                        key={a}
                        type="button"
                        disabled={ocupado}
                        onClick={() => void marcar(a)}
                        className={`flex min-h-[5.5rem] flex-col items-center justify-center gap-1 rounded-2xl px-3 py-4 text-base font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-60 ${ACCION[a].cls} ${
                          a === "salida" && ident.acciones.length === 3 ? "col-span-2 min-h-[4rem]" : ""
                        }`}
                      >
                        <span aria-hidden="true" className="text-2xl leading-none">{ACCION[a].icono}</span>
                        {ACCION[a].titulo}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {error ? <p className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
              <button type="button" onClick={limpiar} className="mt-4 w-full rounded-xl py-2 text-sm text-slate-500 hover:bg-slate-50">
                No soy yo · volver
              </button>
            </div>
          ) : (
            <form onSubmit={(e) => void continuar(e)} autoComplete="off">
              <p className="text-sm text-slate-500">Identificate con tu cédula y tu código de empleado.</p>
              <div className="mt-4 space-y-3">
                <div>
                  <label htmlFor="ma-ced" className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                    Cédula
                  </label>
                  <input
                    ref={cedulaRef}
                    id="ma-ced"
                    name="ma-ced"
                    inputMode="numeric"
                    autoComplete="off"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-lg tabular-nums focus:border-[#4FAEB2] focus:outline-none focus:ring-4 focus:ring-[#4FAEB2]/20"
                    value={cedula}
                    disabled={pidePin}
                    onChange={(e) => setCedula(e.target.value.replace(/[^\d.]/g, "").slice(0, 15))}
                    placeholder="Ej: 4567890"
                  />
                </div>
                <div>
                  <label htmlFor="ma-cod" className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                    Código de empleado
                  </label>
                  <input
                    id="ma-cod"
                    name="ma-cod"
                    autoComplete="off"
                    autoCapitalize="characters"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-lg uppercase focus:border-[#4FAEB2] focus:outline-none focus:ring-4 focus:ring-[#4FAEB2]/20"
                    value={codigo}
                    disabled={pidePin}
                    onChange={(e) => setCodigo(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 20))}
                    placeholder="Te lo da administración"
                  />
                </div>
                {pidePin ? (
                  <div>
                    <label htmlFor="ma-pin" className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                      PIN
                    </label>
                    <input
                      ref={pinRef}
                      id="ma-pin"
                      name="ma-pin"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-center text-2xl tracking-[0.5em] focus:border-[#4FAEB2] focus:outline-none focus:ring-4 focus:ring-[#4FAEB2]/20"
                      value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="••••"
                    />
                  </div>
                ) : null}
              </div>
              {error ? <p className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
              <button
                type="submit"
                disabled={ocupado || !listoParaSeguir}
                className="mt-5 w-full rounded-2xl bg-[#3F8E91] py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-[#357a7d] disabled:opacity-50"
              >
                {ocupado ? "Verificando…" : "Continuar"}
              </button>
              {pidePin ? (
                <button type="button" onClick={limpiar} className="mt-2 w-full rounded-xl py-2 text-sm text-slate-500 hover:bg-slate-50">
                  Volver
                </button>
              ) : (
                <p className="mt-3 text-center text-xs text-slate-400">La marcación queda a tu nombre, no al de la sesión abierta.</p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
