/**
 * Cómo se muestra el historial de un cliente (`cliente_historial`), en el
 * perfil y en el modal de Gestión Clientes. Antes cada pantalla tenía su
 * versión y el modal mostraba los códigos crudos ("duplicate_blocked").
 */

export const ACCION_HISTORIAL: Record<string, { label: string; color: string }> = {
  create: { label: "Cliente creado", color: "bg-emerald-100 text-emerald-700" },
  update: { label: "Datos editados", color: "bg-sky-100 text-sky-700" },
  deactivate: { label: "Baja / inactivación", color: "bg-rose-100 text-rose-700" },
  reactivate: { label: "Reactivación", color: "bg-emerald-100 text-emerald-700" },
  duplicate_blocked: { label: "Alta bloqueada (duplicado)", color: "bg-amber-100 text-amber-700" },
  cambio_plan: { label: "Cambio de plan", color: "bg-violet-100 text-violet-700" },
};

export function etiquetaAccion(accion: string, tipo?: string | null): { label: string; color: string } {
  if (ACCION_HISTORIAL[accion]) return ACCION_HISTORIAL[accion];
  if (tipo === "suscripcion_cambio_plan") return ACCION_HISTORIAL.cambio_plan;
  return { label: accion.replace(/_/g, " "), color: "bg-slate-100 text-slate-600" };
}

export const CAMPO_HISTORIAL: Record<string, string> = {
  empresa: "Nombre de empresa",
  razon_social: "Razón social (factura)",
  ruc_factura: "RUC (factura)",
  nombre: "Nombre",
  nombre_contacto: "Contacto",
  ruc: "RUC",
  documento: "Documento",
  tipo_cliente: "Tipo de cliente",
  estado: "Estado",
  condicion_pago: "Condición de pago",
  moneda_preferida: "Moneda",
  vendedor_usuario_id: "Vendedor",
  project_manager_id: "Project Manager",
  telefono: "Teléfono",
  email: "Email",
  direccion: "Dirección",
};

/** Campos que cambiaron en una edición, con el valor anterior y el nuevo. */
export function resumenCambiosHistorial(detalle: Record<string, unknown> | null | undefined): {
  campo: string;
  antes: string;
  despues: string;
}[] {
  if (!detalle) return [];
  const changed = Array.isArray(detalle.changed_fields) ? (detalle.changed_fields as string[]) : [];
  const before = (detalle.before ?? {}) as Record<string, unknown>;
  const after = (detalle.after ?? {}) as Record<string, unknown>;
  return changed.map((k) => ({
    campo: CAMPO_HISTORIAL[k] ?? k,
    antes: before[k] == null || before[k] === "" ? "—" : String(before[k]),
    despues: after[k] == null || after[k] === "" ? "—" : String(after[k]),
  }));
}

const POR_QUE: Record<string, string> = {
  documento: "el mismo documento",
  nombre: "el mismo nombre",
  ambos: "el mismo nombre y documento",
};

/**
 * Alta bloqueada por duplicado: quién intentaron cargar y por qué coincidió
 * con este cliente. El evento se guarda en la ficha del cliente que ya existía.
 */
export function textoDuplicado(detalle: Record<string, unknown> | null | undefined): string | null {
  if (!detalle) return null;
  const intento = (detalle.intento ?? {}) as { nombre?: string; documento?: string };
  const matches = Array.isArray(detalle.matches) ? (detalle.matches as { match_type?: string }[]) : [];
  const porque = POR_QUE[matches[0]?.match_type ?? ""] ?? "datos iguales";
  const quien = [intento.nombre, intento.documento ? `documento ${intento.documento}` : null].filter(Boolean).join(", ");
  return `Alguien intentó dar de alta ${quien ? `«${quien}»` : "un cliente nuevo"} y el sistema no lo dejó porque tiene ${porque} que este cliente. No se creó ningún cliente nuevo.`;
}
