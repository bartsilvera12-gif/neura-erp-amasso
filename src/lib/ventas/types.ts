export type TipoIvaVenta = "EXENTA" | "5%" | "10%";
export type TipoVenta   = "CONTADO" | "CREDITO";
export type MonedaVenta = "GS" | "USD";

/**
 * Medio de cobro. Son los valores que acepta `ventas.metodo_pago`.
 *
 * Ojo: el crédito NO va acá. Que la venta sea a crédito lo dice `tipo_venta`,
 * y el medio con el que se cobre se registra recién cuando se cobra.
 */
export type MetodoPagoVenta = "efectivo" | "tarjeta" | "transferencia" | "cheque" | "mixto";

export const METODOS_PAGO: { value: MetodoPagoVenta; label: string }[] = [
  { value: "efectivo",      label: "Efectivo" },
  { value: "tarjeta",       label: "Tarjeta" },
  { value: "transferencia", label: "Transferencia" },
  { value: "cheque",        label: "Cheque" },
  { value: "mixto",         label: "Mixto" },
];

/**
 * Con qué se puede cobrar hoy: efectivo, tarjeta, transferencia o cheque. Es la
 * lista que ofrecen la caja y el cobro de ventas a crédito.
 *
 * `mixto` abre el reparto del monto: se tipea cuánto va con cada medio, el
 * total tiene que cuadrar, y el servidor escribe una fila por medio en
 * `ventas_pagos_detalle` y un movimiento de caja por cada una — si no, el
 * arqueo no podría desglosarlo.
 */
export const METODOS_COBRO: { value: MetodoPagoVenta; label: string }[] = METODOS_PAGO;

/** Los medios que pueden formar parte de un cobro mixto (todos menos `mixto`). */
export const METODOS_MIXTO: { value: MetodoPagoVenta; label: string }[] = METODOS_PAGO.filter(
  (m) => m.value !== "mixto"
);

/**
 * `caja_movimientos.medio_pago` usa otro vocabulario que `ventas.metodo_pago`:
 * no tiene `mixto`, tiene `otro`. Esta es la traducción entre los dos.
 */
export function medioPagoDeCaja(metodo: MetodoPagoVenta): string {
  return metodo === "mixto" ? "otro" : metodo;
}

/** Un ítem dentro de una venta (una línea de producto). */
export interface LineaVenta {
  producto_id:           string;
  producto_nombre:       string;
  sku:                   string;
  cantidad:              number;
  precio_venta_original: number;  // en la moneda elegida
  precio_venta:          number;  // siempre en GS
  tipo_iva:              TipoIvaVenta;
  subtotal:              number;  // precio_venta × cantidad
  monto_iva:             number;  // IVA CONTENIDO en el subtotal, no agregado
  total_linea:           number;  // = subtotal: el precio ya lleva el IVA
  /** Unidad del producto (KG, UNIDAD…), para mostrar 1,5 KG y no 1,5 a secas. */
  unidad_medida?:        string | null;
}

/** Cabecera de venta: condiciones comerciales + totales consolidados. */
export interface Venta {
  /** UUID en base de datos (antes del bloque DB-first era numérico local). */
  id:             string;
  numero_control: string;   // VTA-000001, VTA-000002, …

  items: LineaVenta[];       // 1 o más productos

  moneda:      MonedaVenta;
  tipo_cambio: number;       // 1 si moneda === "GS"

  subtotal:  number;         // Σ subtotal de ítems
  monto_iva: number;         // Σ monto_iva de ítems (IVA incluido en el precio)
  total:     number;         // Σ total_linea de ítems = subtotal

  tipo_venta: TipoVenta;
  /** `anulada` deja la venta sin efecto; el número no se reutiliza. */
  estado?: string | null;
  plazo_dias?: number;       // solo si tipo_venta === "CREDITO"

  /** Medio de cobro (`ventas.metodo_pago`). */
  metodo_pago?: MetodoPagoVenta | null;

  /** Caja en la que se cobró. */
  caja_id?: string | null;

  /** Reparto del que salió la mercadería. `null` = venta de mostrador. */
  reparto_id?: string | null;
  /** Lista de precio de la venta: minorista o mayorista (−10%). */
  lista_precio?: "minorista" | "mayorista";

  /** Cliente de la venta. `null` = venta sin nombre. */
  cliente_id?: string | null;
  cliente_nombre?: string | null;
  /** RUC o documento del cliente y su dirección, para la factura. */
  cliente_ruc?: string | null;
  cliente_direccion?: string | null;
  /** "Camion 1 · CAMION PRUEBA" si salió de un reparto. */
  reparto_etiqueta?: string | null;
  /** Quién hizo la venta. Se resuelve en la lectura desde `created_by`. */
  vendedor_nombre?: string | null;
  /**
   * Reparto del cobro cuando `metodo_pago` es `mixto`: una entrada por medio.
   * Solo se manda al crear; se guarda en `ventas_pagos_detalle`.
   */
  pagos?: { metodo_pago: string; monto: number }[];

  fecha: string;             // ISO string, generado automáticamente
}
