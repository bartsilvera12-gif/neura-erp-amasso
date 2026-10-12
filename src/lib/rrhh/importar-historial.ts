import { AsistenciaError, ESTADOS_ASISTENCIA, crearEmpleado, guardarAsistencia, listarEmpleados } from "./asistencia-pg";

/**
 * Importa el historial de asistencia que Amasso lleva hoy en Excel.
 *
 * Una fila por empleado y día. Columnas (el orden no importa, los nombres se
 * comparan sin acentos ni mayúsculas):
 *
 *   EMPLEADO o NOMBRE   obligatoria si no hay CEDULA
 *   CEDULA o DOCUMENTO  identifica mejor que el nombre
 *   FECHA               2026-10-01, 01/10/2026 o fecha de Excel
 *   ENTRADA, SALIDA     05:30, 5:30 u hora de Excel
 *   ESTADO              presente, tarde, ausente, permiso, vacaciones, reposo
 *                       (vacío: presente si hay entrada, ausente si no)
 *   JUSTIFICADA         si / no (solo para ausencias)
 *   OBSERVACION         texto libre
 *
 * Volver a importar el mismo archivo no duplica: hay un registro por empleado
 * y día, y se actualiza. Las filas con error se informan y no frenan el resto.
 */

export type ResultadoImportacion = {
  filas: number;
  importadas: number;
  empleados_creados: string[];
  errores: { fila: number; motivo: string }[];
};

const quitarAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const clave = (s: string) => quitarAcentos(String(s ?? "")).trim().toUpperCase().replace(/\s+/g, " ");

function col(r: Record<string, string>, ...nombres: string[]): string {
  for (const n of nombres) if (r[n] != null && String(r[n]).trim() !== "") return String(r[n]).trim();
  return "";
}

/** Fecha en AAAA-MM-DD desde los formatos que suele tener un Excel. */
export function parseFecha(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 20000) {
    // Número de serie de Excel (días desde 1899-12-30).
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 864e5).toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const anio = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${anio}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

/** Hora en HH:MM desde "5:30", "05:30:00" o una fracción de día de Excel. */
export function parseHora(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  // Fracción de día de Excel (0,2291 = 05:30) o fecha+hora (45930,2291). Un
  // "5.30" escrito a mano NO es fracción: es la hora con punto, va abajo.
  if (/^\d*\.\d+$/.test(s) && (Number(s) < 1 || Number(s) > 20000)) {
    const frac = Number(s) % 1;
    const min = Math.round(frac * 1440) % 1440;
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  }
  const m = s.match(/^(\d{1,2})[:.h](\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  if (/p\.?\s?m/.test(s) && h < 12) h += 12;
  if (/a\.?\s?m/.test(s) && h === 12) h = 0;
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

export async function importarHistorial(
  schema: string,
  empresaId: string,
  filas: Record<string, string>[],
  opts: { crearEmpleados: boolean; registradoPor: string | null }
): Promise<ResultadoImportacion> {
  const empleados = await listarEmpleados(schema, empresaId, true);
  const porDoc = new Map(empleados.filter((e) => e.documento).map((e) => [clave(e.documento!), e.id]));
  const porNombre = new Map(empleados.map((e) => [clave(e.nombre), e.id]));
  const res: ResultadoImportacion = { filas: filas.length, importadas: 0, empleados_creados: [], errores: [] };

  for (let i = 0; i < filas.length; i++) {
    const r = filas[i];
    const n = i + 2; // fila del Excel: la 1 es el encabezado
    const nombre = col(r, "EMPLEADO", "NOMBRE", "NOMBRE_Y_APELLIDO", "FUNCIONARIO");
    const doc = col(r, "CEDULA", "CI", "DOCUMENTO", "NRO_CEDULA").replace(/\./g, "");
    if (!nombre && !doc) {
      // Fila en blanco al final del Excel: se ignora sin error.
      if (Object.values(r).every((v) => !String(v).trim())) {
        res.filas--;
        continue;
      }
      res.errores.push({ fila: n, motivo: "Falta el empleado (nombre o cédula)." });
      continue;
    }
    const fecha = parseFecha(col(r, "FECHA", "DIA"));
    if (!fecha) {
      res.errores.push({ fila: n, motivo: `Fecha inválida: "${col(r, "FECHA", "DIA")}".` });
      continue;
    }
    const entradaTxt = col(r, "ENTRADA", "HORA_ENTRADA", "INGRESO");
    const salidaTxt = col(r, "SALIDA", "HORA_SALIDA", "EGRESO");
    const entrada = parseHora(entradaTxt);
    const salida = parseHora(salidaTxt);
    if (entradaTxt && !entrada) {
      res.errores.push({ fila: n, motivo: `Hora de entrada inválida: "${entradaTxt}".` });
      continue;
    }
    if (salidaTxt && !salida) {
      res.errores.push({ fila: n, motivo: `Hora de salida inválida: "${salidaTxt}".` });
      continue;
    }
    const estadoTxt = quitarAcentos(col(r, "ESTADO", "TIPO")).toLowerCase();
    if (estadoTxt && !(ESTADOS_ASISTENCIA as readonly string[]).includes(estadoTxt)) {
      res.errores.push({ fila: n, motivo: `Estado desconocido: "${estadoTxt}".` });
      continue;
    }
    const just = quitarAcentos(col(r, "JUSTIFICADA", "JUSTIFICADO")).toLowerCase();

    // El empleado se busca (o se crea) recién con la fila validada: si no, una
    // fila con error dejaba creado a un empleado que no tenía ningún registro.
    let empleadoId = (doc && porDoc.get(clave(doc))) || (nombre && porNombre.get(clave(nombre))) || null;
    if (!empleadoId) {
      if (!opts.crearEmpleados || !nombre) {
        res.errores.push({ fila: n, motivo: `No existe el empleado "${nombre || doc}".` });
        continue;
      }
      try {
        const e = await crearEmpleado(schema, empresaId, { nombre, documento: doc || null });
        empleadoId = e.id;
        porNombre.set(clave(e.nombre), e.id);
        if (doc) porDoc.set(clave(doc), e.id);
        res.empleados_creados.push(e.nombre);
      } catch (e) {
        res.errores.push({ fila: n, motivo: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }

    try {
      await guardarAsistencia(
        schema,
        empresaId,
        {
          empleado_id: empleadoId,
          fecha,
          // Sin estado: con entrada, el sistema decide presente o tarde; sin nada, ausente.
          ...(estadoTxt ? { estado: estadoTxt } : entrada ? {} : { estado: "ausente" }),
          ...(entrada ? { entrada } : {}),
          ...(salida ? { salida } : {}),
          ...(just ? { justificada: just.startsWith("s") } : {}),
          ...(col(r, "OBSERVACION", "OBS", "NOTA") ? { observacion: col(r, "OBSERVACION", "OBS", "NOTA") } : {}),
        },
        opts.registradoPor
      );
      res.importadas++;
    } catch (e) {
      res.errores.push({ fila: n, motivo: e instanceof AsistenciaError ? e.message : String(e) });
    }
  }
  return res;
}
