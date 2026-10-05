/**
 * Validaciones de formato para los maestros (clientes, proveedores).
 *
 * Existen porque el ERP aceptaba cualquier cosa en cualquier campo: se podía
 * guardar un cliente con RUC "MARIA" y nombre "123456". Una vez adentro, eso
 * ensucia los reportes, el libro de ventas y el día que se encienda la
 * facturación electrónica rompe el XML.
 *
 * El criterio es avisar, no pelear: se rechaza lo que es claramente de otro
 * tipo (letras en un RUC, números en un nombre), no se exige un formato
 * perfecto. Un campo vacío siempre pasa — lo obligatorio se marca aparte.
 */

/** `null` = válido. Si no, el motivo para mostrar al usuario. */
export type ErrorCampo = string | null;

/**
 * RUC paraguayo: dígitos, con dígito verificador opcional tras un guion.
 * Acepta `80000000-0`, `80000000` y `4567890-1`. No valida el DV: para eso
 * está `calcularDvRuc` en `lib/set/ruc.ts`, que se usa al facturar.
 */
export function validarRuc(v: string): ErrorCampo {
  const s = v.trim();
  if (!s) return null;
  if (/[a-zA-Z]/.test(s)) return "El RUC no lleva letras.";
  if (!/^\d{1,9}(-\d)?$/.test(s)) return "Formato de RUC inválido. Ej: 80000000-0";
  return null;
}

/** Cédula: solo dígitos y puntos de miles. */
export function validarCedula(v: string): ErrorCampo {
  const s = v.trim();
  if (!s) return null;
  if (/[a-zA-Z]/.test(s)) return "La cédula no lleva letras.";
  if (!/^[\d.]{5,15}$/.test(s)) return "Formato de cédula inválido.";
  return null;
}

/**
 * Nombre o razón social: tiene que tener al menos una letra.
 * Se permiten números porque hay nombres comerciales que los llevan
 * ("Panadería 24 Horas"), pero no uno que sea SOLO números.
 */
export function validarNombre(v: string, etiqueta = "El nombre"): ErrorCampo {
  const s = v.trim();
  if (!s) return null;
  if (!/[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ]/.test(s)) return `${etiqueta} tiene que tener letras.`;
  if (s.length < 2) return `${etiqueta} es muy corto.`;
  return null;
}

/** Correo: un `@`, algo a cada lado y un punto en el dominio. */
export function validarEmail(v: string): ErrorCampo {
  const s = v.trim();
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return "Correo inválido. Ej: nombre@dominio.com";
  return null;
}

/** Teléfono: dígitos, con espacios, guiones, paréntesis o `+` opcionales. */
export function validarTelefono(v: string): ErrorCampo {
  const s = v.trim();
  if (!s) return null;
  if (/[a-zA-Z]/.test(s)) return "El teléfono no lleva letras.";
  const digitos = s.replace(/\D/g, "");
  if (digitos.length < 6) return "El teléfono es muy corto.";
  if (digitos.length > 15) return "El teléfono es muy largo.";
  return null;
}

/**
 * Corre varias validaciones y devuelve el primer error, con el nombre del campo
 * adelante. Para usar antes de guardar: si devuelve algo, no se guarda.
 */
export function primerError(
  campos: { etiqueta: string; error: ErrorCampo }[]
): string | null {
  for (const c of campos) {
    if (c.error) return `${c.etiqueta}: ${c.error}`;
  }
  return null;
}
