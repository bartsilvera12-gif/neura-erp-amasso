/**
 * Clases de producto (requerimientos de Amasso, oct-2026). La clase decide si
 * el producto se vende en Caja y si lleva precio de venta:
 *
 *   Clase               ¿Caja?   ¿Precio?
 *   Materia prima        no       no
 *   Insumo / empaque     no       no
 *   Intermedio           no       no      (rellenos, masas base, galleta molida…)
 *   Producto terminado   sí       sí
 *   Reventa              sí       sí
 *   Mermas/devoluciones  no       no
 *
 * Vive en la columna `productos.clase_producto` (script 11). `es_vendible` y
 * `es_insumo` se siguen llenando, derivados de acá, porque los lee la caja.
 */

export const CLASES_PRODUCTO = [
  "materia_prima",
  "insumo",
  "intermedio",
  "terminado",
  "reventa",
  "merma",
] as const;

export type ClaseProducto = (typeof CLASES_PRODUCTO)[number];

export const CLASE_INFO: Record<ClaseProducto, { etiqueta: string; corta: string; detalle: string }> = {
  materia_prima: { etiqueta: "Materia prima", corta: "Materia prima", detalle: "Harina, azúcar, levadura… Va en las formulaciones." },
  insumo: { etiqueta: "Insumo / Empaque", corta: "Insumos", detalle: "Empaques, etiquetas, gas, limpieza. No va en las formulaciones." },
  intermedio: { etiqueta: "Intermedio", corta: "Intermedios", detalle: "Rellenos, masas base, galleta molida. Se produce y se usa en otras formulaciones." },
  terminado: { etiqueta: "Producto terminado", corta: "Terminados", detalle: "Lo que se produce para vender." },
  reventa: { etiqueta: "Reventa", corta: "Reventa", detalle: "Se compra hecho y se vende tal cual." },
  merma: { etiqueta: "Mermas / devoluciones", corta: "Mermas", detalle: "Lo que vuelve o se pierde. No se vende." },
};

export function esClaseProducto(v: unknown): v is ClaseProducto {
  return typeof v === "string" && (CLASES_PRODUCTO as readonly string[]).includes(v);
}

/** Se vende en Caja y lleva precio de venta. */
export function claseVendible(c: ClaseProducto): boolean {
  return c === "terminado" || c === "reventa";
}

/** Se consume en producción (puede ser ingrediente de una formulación). */
export function claseIngrediente(c: ClaseProducto): boolean {
  return c === "materia_prima" || c === "intermedio";
}

/** Lo que entra por compras: los productos solo entran por compra o producción. */
export const CLASES_COMPRABLES: readonly ClaseProducto[] = ["materia_prima", "insumo", "reventa"];

/** Lo que entra por producción. */
export const CLASES_PRODUCIBLES: readonly ClaseProducto[] = ["intermedio", "terminado"];

export function flagsDeClase(c: ClaseProducto): { es_vendible: boolean; es_insumo: boolean } {
  return { es_vendible: claseVendible(c), es_insumo: c === "materia_prima" || c === "insumo" || c === "intermedio" };
}
