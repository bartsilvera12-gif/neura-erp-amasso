"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { Producto } from "@/lib/inventario/types";
import { esPesable, formatCantidad, parseCantidad } from "@/lib/inventario/unidades";

/**
 * Cantidad de un producto dentro del carrito.
 *
 * Un producto discreto se maneja con + / −: es lo más rápido para cargar tres
 * gaseosas y no deja tipear cantidades absurdas.
 *
 * Un producto pesable no: ahí el cajero copia lo que marca la balanza, y
 * subir de a un kilo no sirve para nada. Por eso muestra un campo donde se
 * escribe 1,350 y al lado la unidad, para que quede claro que son kilos y no
 * paquetes.
 */

const TEAL = "#4FAEB2";

export type SelectorCantidadProps = {
  producto: Producto;
  cantidad: number;
  cambiarCantidad: (producto: Producto, delta: number) => void;
  fijarCantidad: (producto: Producto, cantidad: number) => void;
  /** `sm` para el renglón del carrito, `md` para la lista de productos. */
  size?: "sm" | "md";
  /** Se intentó pasar el stock: el campo se pinta de rojo mientras dura el aviso. */
  alerta?: boolean;
};

export default function SelectorCantidad(props: SelectorCantidadProps) {
  if (esPesable(props.producto.unidad_medida)) return <EntradaPeso {...props} />;
  return <BotonesUnidad {...props} />;
}

function BotonesUnidad({
  producto,
  cantidad,
  cambiarCantidad,
  size = "md",
  alerta = false,
}: SelectorCantidadProps) {
  const chico = size === "sm";
  const boton = chico ? "h-7 w-7" : "h-9 w-9";
  const enTope = cantidad >= producto.stock_actual;
  const icono = chico ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <div className={`flex items-center ${chico ? "gap-1.5" : "gap-2"}`}>
      <button
        type="button"
        onClick={() => cambiarCantidad(producto, -1)}
        disabled={cantidad === 0}
        aria-label={`Quitar una unidad de ${producto.nombre}`}
        className={`${boton} flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 disabled:opacity-30`}
      >
        <Minus className={icono} />
      </button>
      <span
        className={`rounded-md text-center font-bold tabular-nums transition-colors ${
          alerta ? "bg-rose-100 text-rose-700 ring-2 ring-rose-400" : "text-slate-900"
        } ${chico ? "w-7 text-xs" : "w-8 text-sm"}`}
      >
        {cantidad}
      </span>
      <button
        type="button"
        // No se deshabilita en el tope: tocarlo tiene que mostrar el aviso de
        // stock, no quedarse quieto sin explicar por qué.
        onClick={() => cambiarCantidad(producto, 1)}
        aria-label={`Agregar una unidad de ${producto.nombre}`}
        title={enTope ? `Máximo disponible: ${producto.stock_actual}` : undefined}
        className={`${boton} flex items-center justify-center rounded-lg text-white ${enTope ? "opacity-40" : ""}`}
        style={{ backgroundColor: TEAL }}
      >
        <Plus className={icono} />
      </button>
    </div>
  );
}

function EntradaPeso({
  producto,
  cantidad,
  fijarCantidad,
  size = "md",
  alerta = false,
}: SelectorCantidadProps) {
  const unidad = producto.unidad_medida;

  // Mientras el cajero escribe manda lo que tipeó, incluso a medio escribir:
  // si el campo se derivara siempre de la cantidad, tipear "1," se convertiría
  // en "1" y nunca llegaría a poner los decimales. Al salir del campo vuelve a
  // mostrar la cantidad real, que puede venir topeada por el stock.
  const [borrador, setBorrador] = useState<string | null>(null);
  const texto = borrador ?? (cantidad > 0 ? formatCantidad(cantidad, unidad) : "");

  const chico = size === "sm";

  return (
    <div className={`flex items-center ${chico ? "gap-1" : "gap-1.5"}`}>
      <input
        inputMode="decimal"
        value={texto}
        onChange={(e) => {
          setBorrador(e.target.value);
          fijarCantidad(producto, parseCantidad(e.target.value, unidad));
        }}
        onBlur={() => setBorrador(null)}
        placeholder="0"
        aria-label={`Cantidad de ${producto.nombre} en ${unidad}`}
        className={`rounded-lg border text-center font-bold tabular-nums outline-none focus:ring-2 focus:ring-[#4FAEB2] ${
          chico ? "h-7 w-16 text-xs" : "h-9 w-20 text-sm"
        } ${
          alerta
            ? "border-rose-400 bg-rose-50 text-rose-700 ring-2 ring-rose-300"
            : cantidad > 0
              ? "border-[#4FAEB2] text-slate-900"
              : "border-slate-200 text-slate-500"
        }`}
      />
      <span className={`font-semibold text-slate-400 ${chico ? "text-[10px]" : "text-xs"}`}>
        {unidad}
      </span>
    </div>
  );
}
