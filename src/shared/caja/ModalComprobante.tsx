"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Ventana sobre la caja para "¡Venta registrada!" y la factura: la caja sigue
 * de fondo, ya limpia para la venta siguiente.
 *
 * Va por portal al <body> para que al imprimir se pueda dejar solo la ventana
 * en el papel (globals.css): dentro del layout, la caja escondida seguía
 * ocupando lugar y sumaba hojas en blanco.
 */
export default function ModalComprobante({
  children,
  onCerrar,
}: {
  children: React.ReactNode;
  /** Cerrar la ventana (X, Escape o clic afuera): deja la caja lista para la venta siguiente. */
  onCerrar?: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar?.();
    };
    window.addEventListener("keydown", esc);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", esc);
    };
  }, [onCerrar]);
  // Solo se abre después de cobrar, siempre en el navegador.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="modal-comprobante fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar?.();
      }}
    >
      <div
        className="flex min-h-full items-start justify-center py-6"
        onClick={(e) => {
          if (e.target === e.currentTarget) onCerrar?.();
        }}
      >
        <div className="relative">
          {children}
          {onCerrar ? (
            <button
              type="button"
              onClick={onCerrar}
              aria-label="Cerrar"
              title="Cerrar"
              className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 print:hidden"
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
