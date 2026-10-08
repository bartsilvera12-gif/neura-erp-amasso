export type MetodoValuacion = "CPP" | "FIFO" | "LIFO";
export type TipoMovimiento = "ENTRADA" | "SALIDA" | "AJUSTE";
export type OrigenMovimiento = "compra" | "venta" | "ajuste_manual" | "inventario_inicial";

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
  /** Insumo para producción. Con `es_vendible = false` es materia prima: no va a la caja. */
  es_insumo?: boolean;
  es_vendible?: boolean;
}

/** Materia prima: se compra y se consume en producción, no se vende. */
export function esMateriaPrima(p: Pick<Producto, "es_insumo" | "es_vendible">): boolean {
  return p.es_vendible === false;
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
}
