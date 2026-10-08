import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Empleados y asistencia (RRHH).
 *
 * `empleados` es la nómina a la que se le toma asistencia, no las cuentas del
 * ERP: en una panadería casi nadie del personal tiene login. Ver
 * `supabase/amasso/09_rrhh_asistencia.sql`.
 *
 * Las horas viajan como "HH:MM" de Paraguay y se guardan como timestamptz
 * armadas con la fecha del registro. Así el que marca a las 05:30 ve 05:30,
 * sin depender de la zona horaria del servidor ni del navegador.
 */

export const ZONA = "America/Asuncion";

/** Minutos de gracia antes de contar una entrada como tarde. */
export const TOLERANCIA_TARDE_MIN = 10;

export const ESTADOS_ASISTENCIA = ["presente", "tarde", "ausente", "permiso", "vacaciones", "reposo"] as const;
export type EstadoAsistencia = (typeof ESTADOS_ASISTENCIA)[number];

export class AsistenciaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type Empleado = {
  id: string;
  nombre: string;
  documento: string | null;
  cargo: string | null;
  telefono: string | null;
  horario_entrada: string | null;
  horario_salida: string | null;
  activo: boolean;
};

export type FilaPlanilla = {
  empleado: Empleado;
  asistencia: {
    id: string;
    estado: EstadoAsistencia;
    entrada: string | null;
    salida: string | null;
    observacion: string | null;
  } | null;
};

export type ResumenEmpleado = {
  empleado_id: string;
  nombre: string;
  cargo: string | null;
  presente: number;
  tarde: number;
  ausente: number;
  permiso: number;
  vacaciones: number;
  reposo: number;
  /** Minutos trabajados en los días con entrada y salida. */
  minutos: number;
  /** Días con entrada pero sin salida: no suman horas y conviene revisarlos. */
  sin_salida: number;
};

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new AsistenciaError("No hay conexión directa a Postgres.", 500);
  return p;
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validarFecha(f: unknown): string {
  const s = String(f ?? "").trim();
  if (!RE_FECHA.test(s)) throw new AsistenciaError("Fecha inválida. Formato AAAA-MM-DD.");
  return s;
}

function horaONull(h: unknown, campo: string): string | null {
  if (h == null || String(h).trim() === "") return null;
  const s = String(h).trim().slice(0, 5);
  if (!RE_HORA.test(s)) throw new AsistenciaError(`${campo}: hora inválida. Formato HH:MM.`);
  return s;
}

function textoONull(v: unknown, max = 200): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function minutosDe(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** "tarde" si entró después del horario más la tolerancia; si no, "presente". */
export function estadoPorEntrada(entrada: string, horarioEntrada: string | null): EstadoAsistencia {
  if (!horarioEntrada) return "presente";
  return minutosDe(entrada) > minutosDe(horarioEntrada.slice(0, 5)) + TOLERANCIA_TARDE_MIN
    ? "tarde"
    : "presente";
}

const COLS_EMPLEADO = `id, nombre, documento, cargo, telefono,
  to_char(horario_entrada, 'HH24:MI') AS horario_entrada,
  to_char(horario_salida, 'HH24:MI') AS horario_salida, activo`;

// ─── Empleados ────────────────────────────────────────────────────────────

export async function listarEmpleados(
  schemaRaw: string,
  empresaId: string,
  incluirInactivos = false
): Promise<Empleado[]> {
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "empleados");
  const { rows } = await pool().query<Empleado>(
    `SELECT ${COLS_EMPLEADO} FROM ${t}
      WHERE empresa_id = $1::uuid ${incluirInactivos ? "" : "AND activo = true"}
      ORDER BY activo DESC, nombre`,
    [empresaId]
  );
  return rows;
}

export type EmpleadoInput = {
  nombre?: unknown;
  documento?: unknown;
  cargo?: unknown;
  telefono?: unknown;
  horario_entrada?: unknown;
  horario_salida?: unknown;
  activo?: unknown;
};

function mensajeUnico(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === "23505" && String(e.constraint ?? "").includes("documento")) {
    throw new AsistenciaError("Ya hay un empleado con ese documento.", 409);
  }
  throw err;
}

export async function crearEmpleado(
  schemaRaw: string,
  empresaId: string,
  d: EmpleadoInput
): Promise<Empleado> {
  const nombre = textoONull(d.nombre, 120);
  if (!nombre) throw new AsistenciaError("El nombre es obligatorio.");
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "empleados");
  try {
    const { rows } = await pool().query<Empleado>(
      `INSERT INTO ${t} (empresa_id, nombre, documento, cargo, telefono, horario_entrada, horario_salida)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::time, $7::time)
       RETURNING ${COLS_EMPLEADO}`,
      [
        empresaId,
        nombre.toUpperCase(),
        textoONull(d.documento, 30),
        textoONull(d.cargo, 80),
        textoONull(d.telefono, 40),
        horaONull(d.horario_entrada, "Horario de entrada"),
        horaONull(d.horario_salida, "Horario de salida"),
      ]
    );
    return rows[0];
  } catch (err) {
    mensajeUnico(err);
  }
}

export async function actualizarEmpleado(
  schemaRaw: string,
  empresaId: string,
  id: string,
  d: EmpleadoInput
): Promise<Empleado> {
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "empleados");
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown, cast = "") => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (d.nombre !== undefined) {
    const nombre = textoONull(d.nombre, 120);
    if (!nombre) throw new AsistenciaError("El nombre no puede quedar vacío.");
    add("nombre", nombre.toUpperCase());
  }
  if (d.documento !== undefined) add("documento", textoONull(d.documento, 30));
  if (d.cargo !== undefined) add("cargo", textoONull(d.cargo, 80));
  if (d.telefono !== undefined) add("telefono", textoONull(d.telefono, 40));
  if (d.horario_entrada !== undefined) add("horario_entrada", horaONull(d.horario_entrada, "Horario de entrada"), "::time");
  if (d.horario_salida !== undefined) add("horario_salida", horaONull(d.horario_salida, "Horario de salida"), "::time");
  if (typeof d.activo === "boolean") add("activo", d.activo, "::boolean");
  if (sets.length === 0) throw new AsistenciaError("No hay nada para actualizar.");
  sets.push("updated_at = now()");
  params.push(id, empresaId);
  try {
    const { rows } = await pool().query<Empleado>(
      `UPDATE ${t} SET ${sets.join(", ")}
        WHERE id = $${params.length - 1}::uuid AND empresa_id = $${params.length}::uuid
        RETURNING ${COLS_EMPLEADO}`,
      params
    );
    if (!rows[0]) throw new AsistenciaError("Empleado no encontrado.", 404);
    return rows[0];
  } catch (err) {
    mensajeUnico(err);
  }
}

// ─── Asistencia ───────────────────────────────────────────────────────────

/** Todos los empleados activos con lo que tengan registrado ese día. */
export async function planillaDelDia(
  schemaRaw: string,
  empresaId: string,
  fechaRaw: unknown
): Promise<FilaPlanilla[]> {
  const fecha = validarFecha(fechaRaw);
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const te = quoteSchemaTable(schema, "empleados");
  const ta = quoteSchemaTable(schema, "asistencias");
  const { rows } = await pool().query(
    `SELECT e.id, e.nombre, e.documento, e.cargo, e.telefono,
            to_char(e.horario_entrada, 'HH24:MI') AS horario_entrada,
            to_char(e.horario_salida, 'HH24:MI') AS horario_salida, e.activo,
            a.id AS a_id, a.estado, a.observacion,
            to_char(a.hora_entrada AT TIME ZONE '${ZONA}', 'HH24:MI') AS entrada,
            to_char(a.hora_salida AT TIME ZONE '${ZONA}', 'HH24:MI') AS salida
       FROM ${te} e
       LEFT JOIN ${ta} a
         ON a.empleado_id = e.id AND a.empresa_id = e.empresa_id AND a.fecha = $2::date
      WHERE e.empresa_id = $1::uuid
        -- Un empleado dado de baja sigue apareciendo en los días que tiene registro.
        AND (e.activo = true OR a.id IS NOT NULL)
      ORDER BY e.nombre`,
    [empresaId, fecha]
  );
  return rows.map((r) => ({
    empleado: {
      id: r.id,
      nombre: r.nombre,
      documento: r.documento,
      cargo: r.cargo,
      telefono: r.telefono,
      horario_entrada: r.horario_entrada,
      horario_salida: r.horario_salida,
      activo: r.activo,
    },
    asistencia: r.a_id
      ? { id: r.a_id, estado: r.estado, entrada: r.entrada, salida: r.salida, observacion: r.observacion }
      : null,
  }));
}

export type GuardarAsistenciaInput = {
  empleado_id?: unknown;
  fecha?: unknown;
  estado?: unknown;
  entrada?: unknown;
  salida?: unknown;
  observacion?: unknown;
};

/**
 * Crea o actualiza el registro del día de un empleado. Solo cambia los campos
 * que vienen: marcar la salida no borra la entrada.
 *
 * Si llega una entrada sin estado, el estado sale del horario del empleado
 * (presente o tarde). Ausente/permiso/vacaciones/reposo limpian las horas: no
 * tiene sentido un ausente con hora de entrada.
 */
export async function guardarAsistencia(
  schemaRaw: string,
  empresaId: string,
  d: GuardarAsistenciaInput,
  registradoPor: string | null
): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const te = quoteSchemaTable(schema, "empleados");
  const ta = quoteSchemaTable(schema, "asistencias");
  const fecha = validarFecha(d.fecha);
  const empleadoId = String(d.empleado_id ?? "").trim();
  if (!empleadoId) throw new AsistenciaError("Falta el empleado.");

  const emp = await pool().query<{ horario_entrada: string | null }>(
    `SELECT to_char(horario_entrada, 'HH24:MI') AS horario_entrada
       FROM ${te} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [empleadoId, empresaId]
  );
  if (!emp.rows[0]) throw new AsistenciaError("Empleado no encontrado.", 404);

  const trae = (k: keyof GuardarAsistenciaInput) => Object.prototype.hasOwnProperty.call(d, k);
  let entrada = trae("entrada") ? horaONull(d.entrada, "Entrada") : undefined;
  let salida = trae("salida") ? horaONull(d.salida, "Salida") : undefined;

  let estado: EstadoAsistencia | undefined;
  if (trae("estado") && d.estado != null && String(d.estado) !== "") {
    const e = String(d.estado);
    if (!(ESTADOS_ASISTENCIA as readonly string[]).includes(e)) {
      throw new AsistenciaError("Estado inválido.");
    }
    estado = e as EstadoAsistencia;
  } else if (entrada) {
    estado = estadoPorEntrada(entrada, emp.rows[0].horario_entrada);
  }
  if (estado && !["presente", "tarde"].includes(estado)) {
    entrada = null;
    salida = null;
  }
  if (entrada && salida && minutosDe(salida) < minutosDe(entrada)) {
    throw new AsistenciaError("La salida no puede ser antes que la entrada.");
  }

  // Columnas que se escriben. En el INSERT las que no vienen quedan en su
  // default; en el UPDATE no se tocan.
  const cols: { col: string; expr: string; val: unknown }[] = [];
  const params: unknown[] = [empresaId, empleadoId, fecha, registradoPor];
  const push = (col: string, val: unknown, expr: (i: number) => string) => {
    params.push(val);
    cols.push({ col, expr: expr(params.length), val });
  };
  const aTimestamp = (i: number) =>
    // El mismo parámetro va siempre como text (y de ahí a time): usarlo como
    // text en un lado y como time en otro hace que Postgres no pueda deducir su tipo.
    `CASE WHEN $${i}::text IS NULL THEN NULL ELSE (($3::date + $${i}::text::time) AT TIME ZONE '${ZONA}') END`;
  if (estado !== undefined) push("estado", estado, (i) => `$${i}`);
  if (entrada !== undefined) push("hora_entrada", entrada, aTimestamp);
  if (salida !== undefined) push("hora_salida", salida, aTimestamp);
  if (trae("observacion")) push("observacion", textoONull(d.observacion, 300), (i) => `$${i}`);
  if (cols.length === 0) throw new AsistenciaError("No hay nada para guardar.");

  try {
  await pool().query(
    `INSERT INTO ${ta} (empresa_id, empleado_id, fecha, registrado_por${cols.map((c) => `, ${c.col}`).join("")})
     VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid${cols.map((c) => `, ${c.expr}`).join("")})
     ON CONFLICT ON CONSTRAINT asistencias_un_registro_por_dia DO UPDATE SET
       ${cols.map((c) => `${c.col} = EXCLUDED.${c.col}`).join(", ")},
       registrado_por = EXCLUDED.registrado_por,
       updated_at = now()`,
    params
  );
  } catch (err) {
    // Marcar solo la salida no trae la entrada para comparar acá: la compara la
    // base. Sin esto el usuario veía el nombre técnico del constraint.
    if ((err as { constraint?: string })?.constraint === "asistencias_salida_despues_de_entrada") {
      throw new AsistenciaError("La salida no puede ser antes que la entrada.");
    }
    throw err;
  }
}

/** Totales del mes por empleado: días por estado y horas trabajadas. */
export async function resumenDelMes(
  schemaRaw: string,
  empresaId: string,
  mesRaw: unknown
): Promise<ResumenEmpleado[]> {
  const mes = String(mesRaw ?? "").trim();
  if (!RE_MES.test(mes)) throw new AsistenciaError("Mes inválido. Formato AAAA-MM.");
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const te = quoteSchemaTable(schema, "empleados");
  const ta = quoteSchemaTable(schema, "asistencias");
  const { rows } = await pool().query(
    `SELECT e.id AS empleado_id, e.nombre, e.cargo,
            count(*) FILTER (WHERE a.estado = 'presente')   AS presente,
            count(*) FILTER (WHERE a.estado = 'tarde')      AS tarde,
            count(*) FILTER (WHERE a.estado = 'ausente')    AS ausente,
            count(*) FILTER (WHERE a.estado = 'permiso')    AS permiso,
            count(*) FILTER (WHERE a.estado = 'vacaciones') AS vacaciones,
            count(*) FILTER (WHERE a.estado = 'reposo')     AS reposo,
            COALESCE(round(sum(extract(epoch FROM (a.hora_salida - a.hora_entrada)) / 60)
                     FILTER (WHERE a.hora_entrada IS NOT NULL AND a.hora_salida IS NOT NULL)), 0) AS minutos,
            count(*) FILTER (WHERE a.hora_entrada IS NOT NULL AND a.hora_salida IS NULL) AS sin_salida
       FROM ${te} e
       LEFT JOIN ${ta} a
         ON a.empleado_id = e.id AND a.empresa_id = e.empresa_id
        AND a.fecha >= ($2 || '-01')::date
        AND a.fecha <  (($2 || '-01')::date + interval '1 month')
      WHERE e.empresa_id = $1::uuid
      GROUP BY e.id, e.nombre, e.cargo, e.activo
     HAVING e.activo = true OR count(a.id) > 0
      ORDER BY e.nombre`,
    [empresaId, mes]
  );
  return rows.map((r) => ({
    empleado_id: r.empleado_id,
    nombre: r.nombre,
    cargo: r.cargo,
    presente: Number(r.presente),
    tarde: Number(r.tarde),
    ausente: Number(r.ausente),
    permiso: Number(r.permiso),
    vacaciones: Number(r.vacaciones),
    reposo: Number(r.reposo),
    minutos: Number(r.minutos),
    sin_salida: Number(r.sin_salida),
  }));
}
