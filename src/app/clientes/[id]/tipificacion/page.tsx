"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getCliente, clienteNombre } from "@/lib/clientes/storage";
import { deleteTipificacion, getTipificaciones, saveTipificacion, updateTipificacion } from "@/lib/gestion-clientes/storage";
import type { Cliente } from "@/lib/clientes/types";
import type { Tipificacion, TipoGestion, ResultadoTipificacion } from "@/lib/gestion-clientes/types";

// ── Constantes ────────────────────────────────────────────────────────────────

const TIPOS_GESTION: TipoGestion[] = [
  "Consulta",
  "Reclamo",
  "Seguimiento",
  "Promesa de pago",
  "Soporte técnico",
  "Cambio plan",
];

const RESULTADOS: ResultadoTipificacion[] = ["Pendiente", "Resuelto", "Escalar"];

const USUARIO_DEFAULT = "ADMINISTRADOR";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatFechaHora(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return ""; }
}

// ── Badges ────────────────────────────────────────────────────────────────────

function BadgeResultado({ resultado }: { resultado: ResultadoTipificacion }) {
  const cfg: Record<ResultadoTipificacion, string> = {
    Pendiente: "bg-amber-100 text-amber-700",
    Resuelto:  "bg-green-100 text-green-700",
    Escalar:   "bg-red-100 text-red-700",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cfg[resultado]}`}>
      {resultado}
    </span>
  );
}

function BadgeTipo({ tipo }: { tipo: TipoGestion }) {
  return (
    <span className="text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-100">
      {tipo}
    </span>
  );
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function TipificacionPage() {
  const params = useParams();
  const router = useRouter();
  if (!params) return null;
  const id = params.id as string;

  const [cliente,        setCliente]        = useState<Cliente | null>(null);
  const [notFound,       setNotFound]       = useState(false);
  const [tipificaciones, setTipificaciones] = useState<Tipificacion[]>([]);
  const [exito,          setExito]          = useState(false);

  const [form, setForm] = useState<{
    tipo_gestion: TipoGestion;
    resultado:    ResultadoTipificacion;
    observacion:  string;
  }>({
    tipo_gestion: "Consulta",
    resultado:    "Pendiente",
    observacion:  "",
  });

  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<{
    id: string;
    tipo_gestion: TipoGestion;
    resultado: ResultadoTipificacion;
    observacion: string;
  } | null>(null);
  const [borrando, setBorrando] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function guardarEdicion() {
    if (!editando || !editando.observacion.trim()) return;
    setOcupado(true);
    const ok = await updateTipificacion(editando.id, {
      tipo_gestion: editando.tipo_gestion,
      resultado: editando.resultado,
      observacion: editando.observacion,
    });
    setOcupado(false);
    if (!ok) return setError("No se pudo guardar el cambio.");
    setEditando(null);
    void cargar();
  }

  async function confirmarBorrar(tipId: string) {
    setOcupado(true);
    const ok = await deleteTipificacion(tipId);
    setOcupado(false);
    if (!ok) return setError("No se pudo borrar la tipificación.");
    setBorrando(null);
    void cargar();
  }

  async function cargar() {
    const c = await getCliente(id);
    if (!c) { setNotFound(true); return; }
    setCliente(c);
    const tips = await getTipificaciones(id);
    setTipificaciones(tips);
  }

  useEffect(() => {
    if (id) void cargar();
    else setNotFound(true);
  }, [id]);

  function handleChange(
    e: React.ChangeEvent<HTMLSelectElement | HTMLTextAreaElement>
  ) {
    setError(null);
    setExito(false);
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleGuardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setExito(false);

    if (!form.observacion.trim()) {
      return setError("La observación es obligatoria.");
    }

    const guardado = await saveTipificacion({
      cliente_id:   id,
      usuario:      USUARIO_DEFAULT,
      tipo_gestion: form.tipo_gestion,
      resultado:    form.resultado,
      observacion:  form.observacion.trim(),
    });

    if (guardado) {
      setForm({ tipo_gestion: "Consulta", resultado: "Pendiente", observacion: "" });
      setExito(true);
      cargar();
      setTimeout(() => setExito(false), 3000);
    } else {
      setError("Error al guardar la tipificación.");
    }
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-gray-800">Cliente no encontrado</h1>
        <button onClick={() => router.push("/clientes")} className="text-sm text-gray-500 underline">
          ← Volver a Clientes
        </button>
      </div>
    );
  }

  if (!cliente) return null;

  return (
    <div className="space-y-6 max-w-4xl">

      {/* ── Breadcrumb ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <button onClick={() => router.push("/gestion-clientes")} className="hover:text-gray-600 transition-colors">
          Gestión de clientes
        </button>
        <span>›</span>
        <button onClick={() => router.push(`/clientes/${id}`)} className="hover:text-gray-600 transition-colors">
          {clienteNombre(cliente)}
        </button>
        <span>›</span>
        <span className="text-gray-600 font-medium">Tipificación</span>
      </div>

      {/* ── Header del cliente ────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{clienteNombre(cliente)}</h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
              <span className="font-mono">{cliente.codigo_cliente}</span>
              {cliente.ruc && <span>RUC: {cliente.ruc}</span>}
              {cliente.telefono && <span>Tel: {cliente.telefono}</span>}
              {cliente.email && <span>{cliente.email}</span>}
            </div>
          </div>
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
            cliente.estado === "activo" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
          }`}>
            {cliente.estado === "activo" ? "● Activo" : "● Inactivo"}
          </span>
        </div>
      </div>

      {/* ── Formulario de nueva tipificación ─────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gray-50 border-b border-gray-200 px-6 py-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
            Nueva tipificación
          </p>
        </div>

        <form onSubmit={handleGuardar} className="p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">

            {/* Tipo de gestión */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Tipo de gestión <span className="text-red-500">*</span>
              </label>
              <select
                name="tipo_gestion"
                value={form.tipo_gestion}
                onChange={handleChange}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/30 transition-colors bg-white"
              >
                {TIPOS_GESTION.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* Resultado */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Resultado <span className="text-red-500">*</span>
              </label>
              <select
                name="resultado"
                value={form.resultado}
                onChange={handleChange}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/30 transition-colors bg-white"
              >
                {RESULTADOS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Observación */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Observación <span className="text-red-500">*</span>
            </label>
            <textarea
              name="observacion"
              value={form.observacion}
              onChange={handleChange}
              rows={3}
              placeholder="Describí la gestión realizada con el cliente..."
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/30 transition-colors resize-none"
            />
          </div>

          {/* Aviso usuario */}
          <p className="text-xs text-gray-400 mb-4">
            👤 Se registrará como: <span className="font-semibold text-gray-600">{USUARIO_DEFAULT}</span>
          </p>

          {/* Error / Éxito */}
          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">
              <span>⚠</span><span className="font-medium">{error}</span>
            </div>
          )}

          {exito && (
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2.5 text-sm text-green-700 font-medium mb-4">
              ✓ Tipificación registrada correctamente.
            </div>
          )}

          <button
            type="submit"
            className="rounded-xl bg-[#4FAEB2] px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#3F8E91]"
          >
            Guardar tipificación
          </button>
        </form>
      </div>

      {/* ── Historial de tipificaciones ───────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gray-50 border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
            Historial de tipificaciones
          </p>
          <span className="text-xs font-bold text-gray-600 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
            {tipificaciones.length}
          </span>
        </div>

        {tipificaciones.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">
            No hay tipificaciones registradas para este cliente.
          </div>
        ) : (
          <ul className="space-y-3 p-4">
            {tipificaciones.map((t) => {
              const ed = editando?.id === t.id ? editando : null;
              return (
                <li key={t.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
                  <div className="flex items-start gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      {ed ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <select
                              value={ed.tipo_gestion}
                              onChange={(e) => setEditando({ ...ed, tipo_gestion: e.target.value as TipoGestion })}
                              className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/30"
                              aria-label="Tipo de gestión"
                            >
                              {TIPOS_GESTION.map((x) => <option key={x}>{x}</option>)}
                            </select>
                            <select
                              value={ed.resultado}
                              onChange={(e) => setEditando({ ...ed, resultado: e.target.value as ResultadoTipificacion })}
                              className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/30"
                              aria-label="Resultado"
                            >
                              {RESULTADOS.map((x) => <option key={x}>{x}</option>)}
                            </select>
                          </div>
                          <textarea
                            autoFocus
                            rows={3}
                            value={ed.observacion}
                            onChange={(e) => setEditando({ ...ed, observacion: e.target.value })}
                            onKeyDown={(e) => e.key === "Escape" && setEditando(null)}
                            className="w-full resize-none rounded-xl border border-[#4FAEB2] px-3 py-2 text-sm outline-none ring-2 ring-[#4FAEB2]/25"
                            aria-label="Observación"
                          />
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <BadgeTipo tipo={t.tipo_gestion} />
                            <BadgeResultado resultado={t.resultado} />
                          </div>
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{t.observacion}</p>
                          <p className="mt-2 text-[11px] text-slate-400">
                            {formatFechaHora(t.fecha)} · {t.usuario}
                          </p>
                        </>
                      )}
                    </div>
                    {!ed && borrando !== t.id ? (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => setEditando({ id: t.id, tipo_gestion: t.tipo_gestion, resultado: t.resultado, observacion: t.observacion })}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-[#4FAEB2] hover:text-[#2F7A7D]"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => setBorrando(t.id)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                        >
                          Borrar
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {ed ? (
                    <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-2.5">
                      <button type="button" onClick={() => setEditando(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                        Cancelar
                      </button>
                      <button
                        type="button"
                        disabled={ocupado || !ed.observacion.trim()}
                        onClick={() => void guardarEdicion()}
                        className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50"
                      >
                        {ocupado ? "Guardando…" : "Guardar"}
                      </button>
                    </div>
                  ) : null}
                  {borrando === t.id ? (
                    <div className="flex items-center justify-between gap-2 border-t border-rose-100 bg-rose-50/60 px-5 py-2.5">
                      <p className="text-xs text-rose-700">¿Borrar esta tipificación? No se puede deshacer.</p>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setBorrando(null)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={ocupado}
                          onClick={() => void confirmarBorrar(t.id)}
                          className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                        >
                          Borrar
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

    </div>
  );
}
