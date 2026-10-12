"use client";

import { AlertTriangle } from "lucide-react";
import type { AvisoStock } from "./useCajaVenta";
import { formatCantidad } from "@/lib/inventario/unidades";

/**
 * Aviso flotante cuando se intenta vender más de lo que hay. La cantidad ya
 * quedó en el máximo; esto explica por qué y cuánto es ese máximo.
 */
export default function AvisoStockFlotante({ aviso }: { aviso: AvisoStock | null }) {
  if (!aviso) return null;
  return (
    <div
      key={aviso.n}
      role="alert"
      className="fixed bottom-6 left-1/2 z-50 flex w-[min(92vw,28rem)] -translate-x-1/2 items-start gap-3 rounded-xl border border-rose-200 bg-white px-4 py-3 shadow-lg shadow-rose-900/10"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-semibold text-slate-900">No hay más stock de {aviso.nombre}</p>
        <p className="mt-0.5 text-slate-600">
          Máximo que se puede vender:{" "}
          <strong className="text-rose-700">
            {formatCantidad(aviso.max, aviso.unidad)} {aviso.unidad}
          </strong>
          . Ya quedó cargado ese máximo.
        </p>
      </div>
    </div>
  );
}
