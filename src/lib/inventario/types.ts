import type { ClaseProducto } from "./clases";

export type MetodoValuacion = "CPP" | "FIFO" | "LIFO";
export type TipoMovimiento = "ENTRADA" | "SALIDA" | "AJUSTE";
/** Los mismos que acepta el CHECK `movimientos_origen_valido`. */
export type OrigenMovimiento =
  | "compra"
  | "venta"
  | "ajuste_manual"
  | "inventario_inicial"
  | "produccion"
  | "transferencia"
  | "recepcion"
  | "carga_proveedor"
  | "rendicion_reparto"
  | "anulacion";

export interface Producto {
  id: string;
  nombre: string;
  sku: string;
  costo_promedio: number;
  precio_venta: number;
  stock_actual: number;
  stock_minimo: number;
  unidad_medida: string;
  metodo_valuacion: MetodoValuacion;
  codigo_barras?: string | null;
  codigo_barras_interno?: boolean;
  imagen_path?: string | null;
  imagen_url?: string | null;
  categoria_principal_id?: string | null;
  ubicacion_principal_id?: string | null;
  proveedor_principal_id?: string | null;
  /** IVA con el que se vende: "5%" (pollo), "10%", "EXENTA". `null` = sin definir. */
  tipo_iva?: string | null;
  /** Derivados de `clase_producto`; la caja usa `es_vendible`. */
  es_insumo?: boolean;
  es_vendible?: boolean;
  /** Ver `lib/inventario/clases.ts`. */
  clase_producto?: ClaseProducto;
}

/** No se vende en Caja (materia prima, insumo, intermedio, merma). */
export function esMateriaPrima(p: Pick<Producto, "es_insumo" | "es_vendible">): boolean {
  return p.es_vendible === false;
}

/** Clase efectiva: la guardada o, si falta, deducida de `es_vendible`. */
export function claseDe(p: Pick<Producto, "clase_producto" | "es_vendible">): ClaseProducto {
  return p.clase_producto ?? (p.es_vendible === false ? "materia_prima" : "reventa");
}

export interface MovimientoInventario {
  id: string;
  producto_id: string;
  producto_nombre: string;
  producto_sku: string;
  tipo: TipoMovimiento;
  cantidad: number;
  costo_unitario: number;
  origen: OrigenMovimiento;
  fecha: string;       // ISO string
  referencia?: string; // ej: "COMP-000001"
  created_by?: string | null;
  usuario_nombre?: string | null;
  /** Por qué (ajustes) o hacia/desde dónde (transferencias). */
  motivo?: string | null;
}
