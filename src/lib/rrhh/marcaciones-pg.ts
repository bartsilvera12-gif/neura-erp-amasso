import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { AsistenciaError, ZONA, estadoPorEntrada } from "./asistencia-pg";
import { verificarPin } from "./pin";

/**
 * Marcación de asistencia por el propio empleado (especificación de Amasso).
 *
 * El empleado no tiene cuenta del ERP: se identifica con cédula + código (y su
 * PIN, si tiene uno) dentro de cualquier sesión abierta. La marcación queda a
 * nombre del empleado; de la sesión solo se guarda quién estaba logueado y
 * desde qué dispositivo, para auditar. Nunca se cambia ni se asume la sesión.
 *
 * Cada marcación es un evento. La secuencia la controla el servidor:
 *
 *   sin entrada  → Entrada
 *   trabajando   → Inicio de break · Inicio de almuerzo (uno por jornada) · Salida
 *   en break     → Fin de break · Salida (cierra el break con aviso)
 *   en almuerzo  → Fin de almuerzo · Salida (cierra el almuerzo con aviso)
 *   cerrada      → nada hasta la próxima jornada
 *
 * La hora es la del servidor, en hora de Paraguay. Dos marcaciones simultáneas
 * del mismo empleado se ordenan con un bloqueo de su fila: la segunda ve el
 * estado que dejó la primera y, si ya no corresponde, se rechaza.
 *
 * Después de cada marcación o corrección se recalcula el resumen del día
 * (`asistencias`): entrada, salida, minutos de break y almuerzo, tarde o no.
 * La planilla, el resumen del mes y la liquidación leen ese resumen.
 */

export const TIPOS_EVENTO = ["entrada", "inicio_break", "fin_break", "inicio_almuerzo", "fin_almuerzo", "salida"] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

export const ETIQUETA_EVENTO: Record<TipoEvento, string> = {
  entrada: "Entrada",
  inicio_break: "Inicio de break",
  fin_break: "Fin de break",
  inicio_almuerzo: "Inicio de almuerzo",
  fin_almuerzo: "Fin de almuerzo",
  salida: "Salida",
};

export type EstadoJornada = "sin_entrada" | "trabajando" | "en_break" | "en_almuerzo" | "cerrada";

/** Una jornada abierta hace más de esto se da por abandonada (olvido de salida). */
const HORAS_JORNADA_MAX = 20;
/** Intentos fallidos de identificación permitidos por sesión, en la ventana. */
const MAX_INTENTOS = 5;
const VENTANA_INTENTOS_MIN = 10;

type Q = { query: <R = Record<string, unknown>>(sql: string, p?: unknown[]) => Promise<{ rows: R[] }> };

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new AsistenciaError("No hay conexión directa a Postgres.", 500);
  return p;
}

function t(schemaRaw: string) {
  const s = assertAllowedChatDataSchema(schemaRaw);
  return {
    E: quoteSchemaTable(s, "empleados"),
    EV: quoteSchemaTable(s, "asistencia_eventos"),
    C: quoteSchemaTable(s, "asistencia_correcciones"),
    I: quoteSchemaTable(s, "asistencia_intentos"),
    A: quoteSchemaTable(s, "asistencias"),
  };
}

// ─── Estado de la jornada ─────────────────────────────────────────────────

/** `ep`: segundos desde 1970 (el texto de un timestamptz de Postgres no siempre lo entiende Date.parse). */
type Evento = { id: string; tipo: TipoEvento; momento: string; jornada: string; ep: number };

const COLS_EVENTO = `id, tipo, momento::text AS momento, jornada::text AS jornada, extract(epoch FROM momento)::float8 AS ep`;

/** Hoy en Paraguay (AAAA-MM-DD), según el servidor de base de datos. */
async function hoyPY(c: Q): Promise<string> {
  const r = await c.query<{ d: string }>(`SELECT (now() AT TIME ZONE '${ZONA}')::date::text AS d`);
  return r.rows[0].d;
}

export type EstadoActual = {
  estado: EstadoJornada;
  jornada: string | null;
  acciones: TipoEvento[];
  almuerzoUsado: boolean;
  /** Hubo una jornada anterior sin salida que quedó incompleta. */
  jornadaAnteriorIncompleta: string | null;
};

function estadoDesdeEventos(evs: Evento[]): EstadoJornada {
  const ultimo = evs[evs.length - 1];
  if (!ultimo) return "sin_entrada";
  switch (ultimo.tipo) {
    case "inicio_break":
      return "en_break";
    case "inicio_almuerzo":
      return "en_almuerzo";
    case "salida":
      return "cerrada";
    default:
      return "trabajando";
  }
}

function accionesPara(estado: EstadoJornada, almuerzoUsado: boolean): TipoEvento[] {
  switch (estado) {
    case "sin_entrada":
      return ["entrada"];
    case "trabajando":
      return almuerzoUsado ? ["inicio_break", "salida"] : ["inicio_break", "inicio_almuerzo", "salida"];
    case "en_break":
      return ["fin_break", "salida"];
    case "en_almuerzo":
      return ["fin_almuerzo", "salida"];
    case "cerrada":
      return [];
  }
}

async function estadoDe(c: Q, schemaRaw: string, empresaId: string, empleadoId: string): Promise<EstadoActual> {
  const { EV } = t(schemaRaw);
  const hoy = await hoyPY(c);
  // Última jornada con marcaciones válidas.
  const ult = await c.query<{ jornada: string; horas: number }>(
    `SELECT jornada::text AS jornada, extract(epoch FROM now() - min(momento))::float8 / 3600 AS horas FROM ${EV}
      WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND NOT anulado
      GROUP BY jornada ORDER BY jornada DESC LIMIT 1`,
    [empresaId, empleadoId]
  );
  const j = ult.rows[0];
  if (!j) return { estado: "sin_entrada", jornada: null, acciones: ["entrada"], almuerzoUsado: false, jornadaAnteriorIncompleta: null };
  const evs = (
    await c.query<Evento>(
      `SELECT ${COLS_EVENTO} FROM ${EV}
        WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND jornada = $3::date AND NOT anulado
        ORDER BY momento, created_at`,
      [empresaId, empleadoId, j.jornada]
    )
  ).rows;
  const estado = estadoDesdeEventos(evs);
  const almuerzoUsado = evs.some((e) => e.tipo === "inicio_almuerzo");

  // Jornada cerrada de un día anterior, o abierta pero abandonada: empieza otra.
  const horasDesdeEntrada = Number(j.horas);
  if (estado === "cerrada" && j.jornada < hoy) {
    return { estado: "sin_entrada", jornada: null, acciones: ["entrada"], almuerzoUsado: false, jornadaAnteriorIncompleta: null };
  }
  if (estado !== "cerrada" && horasDesdeEntrada > HORAS_JORNADA_MAX) {
    return { estado: "sin_entrada", jornada: null, acciones: ["entrada"], almuerzoUsado: false, jornadaAnteriorIncompleta: j.jornada };
  }
  return { estado, jornada: j.jornada, acciones: accionesPara(estado, almuerzoUsado), almuerzoUsado, jornadaAnteriorIncompleta: null };
}

// ─── Identificación ───────────────────────────────────────────────────────

export type Credenciales = { cedula?: unknown; codigo?: unknown; pin?: unknown };
export type EmpleadoIdentificado = { id: string; nombre: string; horario_entrada: string | null };

const normalizarDoc = (v: unknown) => String(v ?? "").replace(/[.\s-]/g, "").trim().toUpperCase();

async function registrarIntento(c: Q, schemaRaw: string, empresaId: string, clave: string, exitoso: boolean) {
  const { I } = t(schemaRaw);
  await c.query(`INSERT INTO ${I} (empresa_id, clave, exitoso) VALUES ($1::uuid, $2, $3)`, [empresaId, clave, exitoso]);
}

/**
 * Valida cédula + código (+ PIN si el empleado tiene uno). El mensaje de error
 * es siempre el mismo para no revelar cuál de los datos está mal. Cinco fallos
 * en diez minutos desde la misma sesión bloquean los intentos un rato.
 */
async function identificarEn(
  c: Q,
  schemaRaw: string,
  empresaId: string,
  cred: Credenciales,
  claveSesion: string
): Promise<{ empleado: EmpleadoIdentificado } | { requierePin: true }> {
  const { E, I } = t(schemaRaw);
  const fallos = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${I}
      WHERE empresa_id = $1::uuid AND clave = $2 AND NOT exitoso
        AND created_at > now() - interval '${VENTANA_INTENTOS_MIN} minutes'`,
    [empresaId, claveSesion]
  );
  if (Number(fallos.rows[0]?.n ?? 0) >= MAX_INTENTOS) {
    throw new AsistenciaError(`Demasiados intentos fallidos. Esperá ${VENTANA_INTENTOS_MIN} minutos y probá de nuevo.`, 429);
  }
  const cedula = normalizarDoc(cred.cedula);
  const codigo = String(cred.codigo ?? "").trim().toUpperCase();
  if (!cedula || !codigo) throw new AsistenciaError("Ingresá tu cédula y tu código de empleado.");

  const r = await c.query<{ id: string; nombre: string; pin_hash: string | null; horario_entrada: string | null }>(
    `SELECT id, nombre, pin_hash, to_char(horario_entrada, 'HH24:MI') AS horario_entrada FROM ${E}
      WHERE empresa_id = $1::uuid AND activo
        AND upper(btrim(codigo)) = $2
        AND upper(regexp_replace(coalesce(documento, ''), '[.\\s-]', '', 'g')) = $3
      LIMIT 1`,
    [empresaId, codigo, cedula]
  );
  const emp = r.rows[0];
  if (!emp) {
    await registrarIntento(c, schemaRaw, empresaId, claveSesion, false);
    throw new AsistenciaError("No encontramos un empleado activo con esa cédula y ese código.", 404);
  }
  if (emp.pin_hash) {
    const pin = String(cred.pin ?? "").trim();
    if (!pin) return { requierePin: true };
    if (!verificarPin(pin, emp.pin_hash)) {
      await registrarIntento(c, schemaRaw, empresaId, claveSesion, false);
      throw new AsistenciaError("El PIN no es correcto.", 401);
    }
  }
  await registrarIntento(c, schemaRaw, empresaId, claveSesion, true);
  return { empleado: { id: emp.id, nombre: emp.nombre, horario_entrada: emp.horario_entrada } };
}

export type RespuestaIdentificar =
  | { requiere_pin: true }
  | { requiere_pin: false; nombre: string; estado: EstadoJornada; acciones: TipoEvento[]; aviso: string | null };

export async function identificar(
  schemaRaw: string,
  empresaId: string,
  cred: Credenciales,
  claveSesion: string
): Promise<RespuestaIdentificar> {
  const c = pool() as unknown as Q;
  const id = await identificarEn(c, schemaRaw, empresaId, cred, claveSesion);
  if ("requierePin" in id) return { requiere_pin: true };
  const est = await estadoDe(c, schemaRaw, empresaId, id.empleado.id);
  return {
    requiere_pin: false,
    nombre: id.empleado.nombre,
    estado: est.estado,
    acciones: est.acciones,
    aviso:
      est.estado === "cerrada"
        ? "Tu jornada de hoy ya está cerrada. La próxima marcación es la entrada de mañana."
        : est.jornadaAnteriorIncompleta
          ? `Tu jornada del ${est.jornadaAnteriorIncompleta.split("-").reverse().join("/")} quedó sin salida. Avisale a administración para corregirla.`
          : null,
  };
}

// ─── Marcar ───────────────────────────────────────────────────────────────

export type ResultadoMarcacion = { nombre: string; tipo: TipoEvento; etiqueta: string; hora: string; aviso: string | null };

export async function marcar(
  schemaRaw: string,
  empresaId: string,
  cred: Credenciales,
  tipoRaw: unknown,
  sesion: { usuarioId: string | null; usuarioNombre: string | null; dispositivo: string | null; clave: string }
): Promise<ResultadoMarcacion> {
  const tipo = String(tipoRaw ?? "") as TipoEvento;
  if (!(TIPOS_EVENTO as readonly string[]).includes(tipo)) throw new AsistenciaError("Marcación desconocida.");
  const { E, EV } = t(schemaRaw);
  const client = await pool().connect();
  const c = client as unknown as Q;
  try {
    await client.query("BEGIN");
    const id = await identificarEn(c, schemaRaw, empresaId, cred, sesion.clave);
    if ("requierePin" in id) throw new AsistenciaError("Ingresá tu PIN.", 401);
    // Bloqueo del empleado: dos marcaciones a la vez se hacen una después de otra.
    await c.query(`SELECT id FROM ${E} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [id.empleado.id, empresaId]);
    const est = await estadoDe(c, schemaRaw, empresaId, id.empleado.id);
    if (!est.acciones.includes(tipo)) {
      throw new AsistenciaError(
        est.estado === "cerrada"
          ? "Tu jornada de hoy ya está cerrada."
          : `No corresponde marcar ${ETIQUETA_EVENTO[tipo].toLowerCase()} ahora. Lo que podés marcar: ${est.acciones.map((a) => ETIQUETA_EVENTO[a]).join(", ")}.`,
        409
      );
    }
    const hoy = await hoyPY(c);
    const jornada = tipo === "entrada" ? hoy : est.jornada ?? hoy;
    let aviso: string | null = null;
    const ins = async (tp: TipoEvento) =>
      c.query(
        `INSERT INTO ${EV} (empresa_id, empleado_id, jornada, tipo, origen, sesion_usuario_id, sesion_usuario_nombre, dispositivo)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, 'autoservicio', $5::uuid, $6, $7)`,
        [empresaId, id.empleado.id, jornada, tp, sesion.usuarioId, sesion.usuarioNombre, sesion.dispositivo?.slice(0, 200) ?? null]
      );
    // Salida con una pausa abierta: se cierra la pausa en el mismo momento.
    if (tipo === "salida" && (est.estado === "en_break" || est.estado === "en_almuerzo")) {
      await ins(est.estado === "en_break" ? "fin_break" : "fin_almuerzo");
      aviso = `Tenías ${est.estado === "en_break" ? "un break" : "el almuerzo"} abierto: se cerró con la salida.`;
    }
    await ins(tipo);
    // La jornada anterior quedó sin salida: se marca como incompleta en el resumen.
    if (est.jornadaAnteriorIncompleta) {
      await resincronizarDia(c, schemaRaw, empresaId, id.empleado.id, est.jornadaAnteriorIncompleta, id.empleado.horario_entrada);
    }
    await resincronizarDia(c, schemaRaw, empresaId, id.empleado.id, jornada, id.empleado.horario_entrada);
    const h = await c.query<{ h: string }>(`SELECT to_char(now() AT TIME ZONE '${ZONA}', 'HH24:MI') AS h`);
    await client.query("COMMIT");
    return { nombre: id.empleado.nombre, tipo, etiqueta: ETIQUETA_EVENTO[tipo], hora: h.rows[0].h, aviso };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Resumen diario a partir de las marcaciones ───────────────────────────

/** Pares inicio→fin de un tipo de pausa, en minutos. Una pausa sin cierre no suma. */
function minutosDePausa(evs: Evento[], inicio: TipoEvento, fin: TipoEvento): number {
  let total = 0;
  let abierto: number | null = null;
  for (const e of evs) {
    if (e.tipo === inicio) abierto = Number(e.ep);
    else if (e.tipo === fin && abierto != null) {
      total += (Number(e.ep) - abierto) / 60;
      abierto = null;
    }
  }
  return Math.round(total);
}

/** Valida que la secuencia de un día tenga sentido (para correcciones). */
export function secuenciaValida(evs: { tipo: TipoEvento }[]): string | null {
  let estado: EstadoJornada = "sin_entrada";
  let almuerzos = 0;
  let anterior: TipoEvento | null = null;
  for (const e of evs) {
    const permitidas = accionesPara(estado, almuerzos > 0);
    if (!permitidas.includes(e.tipo)) {
      if (e.tipo === "inicio_almuerzo" && almuerzos > 0) return "Solo puede haber un almuerzo por jornada.";
      return anterior
        ? `La secuencia no cierra: “${ETIQUETA_EVENTO[e.tipo]}” no puede ir después de “${ETIQUETA_EVENTO[anterior]}”.`
        : `La jornada tiene que empezar con una entrada, no con “${ETIQUETA_EVENTO[e.tipo]}”.`;
    }
    if (e.tipo === "inicio_almuerzo") almuerzos++;
    estado = estadoDesdeEventos([e as Evento]);
    anterior = e.tipo;
  }
  return null;
}

async function resincronizarDia(
  c: Q,
  schemaRaw: string,
  empresaId: string,
  empleadoId: string,
  jornada: string,
  horarioEntrada: string | null
) {
  const { EV, A } = t(schemaRaw);
  const evs = (
    await c.query<Evento>(
      `SELECT ${COLS_EVENTO} FROM ${EV}
        WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND jornada = $3::date AND NOT anulado
        ORDER BY momento, created_at`,
      [empresaId, empleadoId, jornada]
    )
  ).rows;
  const entrada = evs.find((e) => e.tipo === "entrada");
  const salida = [...evs].reverse().find((e) => e.tipo === "salida");
  if (!entrada) {
    // Sin marcaciones válidas: si el día existía solo por las marcaciones, se
    // vuelve a "sin marcar". Un estado puesto a mano (permiso, vacaciones…) queda.
    await c.query(
      `DELETE FROM ${A} WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND fecha = $3::date
          AND estado IN ('presente', 'tarde')`,
      [empresaId, empleadoId, jornada]
    );
    await c.query(
      `UPDATE ${A} SET hora_entrada = NULL, hora_salida = NULL, minutos_break = 0, minutos_almuerzo = 0, incompleta = false,
              updated_at = now()
        WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND fecha = $3::date`,
      [empresaId, empleadoId, jornada]
    );
    return;
  }
  const hora = await c.query<{ h: string }>(`SELECT to_char($1::timestamptz AT TIME ZONE '${ZONA}', 'HH24:MI') AS h`, [entrada.momento]);
  const estado = estadoPorEntrada(hora.rows[0].h, horarioEntrada);
  const hoy = await hoyPY(c);
  const incompleta = !salida && jornada < hoy;
  await c.query(
    `INSERT INTO ${A} (empresa_id, empleado_id, fecha, estado, hora_entrada, hora_salida, minutos_break, minutos_almuerzo, incompleta, justificada)
     VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, NULL)
     ON CONFLICT ON CONSTRAINT asistencias_un_registro_por_dia DO UPDATE SET
       estado = EXCLUDED.estado, hora_entrada = EXCLUDED.hora_entrada, hora_salida = EXCLUDED.hora_salida,
       minutos_break = EXCLUDED.minutos_break, minutos_almuerzo = EXCLUDED.minutos_almuerzo,
       incompleta = EXCLUDED.incompleta, justificada = NULL, updated_at = now()`,
    [
      empresaId, empleadoId, jornada, estado, entrada.momento, salida?.momento ?? null,
      minutosDePausa(evs, "inicio_break", "fin_break"), minutosDePausa(evs, "inicio_almuerzo", "fin_almuerzo"), incompleta,
    ]
  );
}

// ─── Administración: listado, día, correcciones ───────────────────────────

export type MarcacionFila = {
  id: string;
  empleado_id: string;
  empleado: string;
  documento: string | null;
  codigo: string | null;
  jornada: string;
  tipo: TipoEvento;
  hora: string;
  fecha_hora: string;
  origen: string;
  sesion_usuario_nombre: string | null;
  dispositivo: string | null;
  anulado: boolean;
  corregido: boolean;
};

export async function listarMarcaciones(
  schemaRaw: string,
  empresaId: string,
  f: { empleadoId?: string | null; desde: string; hasta: string; tipo?: string | null; incluirAnuladas?: boolean }
): Promise<MarcacionFila[]> {
  const { E, EV, C } = t(schemaRaw);
  const params: unknown[] = [empresaId, f.desde, f.hasta];
  let extra = "";
  if (f.empleadoId) {
    params.push(f.empleadoId);
    extra += ` AND ev.empleado_id = $${params.length}::uuid`;
  }
  if (f.tipo && (TIPOS_EVENTO as readonly string[]).includes(f.tipo)) {
    params.push(f.tipo);
    extra += ` AND ev.tipo = $${params.length}`;
  }
  if (!f.incluirAnuladas) extra += " AND NOT ev.anulado";
  const { rows } = await pool().query<MarcacionFila>(
    `SELECT ev.id, ev.empleado_id, e.nombre AS empleado, e.documento, e.codigo, ev.jornada::text AS jornada, ev.tipo,
            to_char(ev.momento AT TIME ZONE '${ZONA}', 'HH24:MI') AS hora,
            to_char(ev.momento AT TIME ZONE '${ZONA}', 'YYYY-MM-DD HH24:MI') AS fecha_hora,
            ev.origen, ev.sesion_usuario_nombre, ev.dispositivo, ev.anulado,
            EXISTS (SELECT 1 FROM ${C} c WHERE c.evento_id = ev.id) AS corregido
       FROM ${EV} ev JOIN ${E} e ON e.id = ev.empleado_id
      WHERE ev.empresa_id = $1::uuid AND ev.jornada BETWEEN $2::date AND $3::date ${extra}
      ORDER BY ev.momento DESC
      LIMIT 2000`,
    params
  );
  return rows;
}

export async function tieneMarcaciones(schemaRaw: string, empresaId: string, empleadoId: string, jornada: string): Promise<boolean> {
  const { EV } = t(schemaRaw);
  const r = await pool().query(
    `SELECT 1 FROM ${EV} WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND jornada = $3::date AND NOT anulado LIMIT 1`,
    [empresaId, empleadoId, jornada]
  );
  return r.rows.length > 0;
}

export type JornadaIncompleta = { empleado_id: string; empleado: string; jornada: string; ultima: string; ultimo_tipo: TipoEvento };

/** Jornadas de días anteriores que tienen entrada y no salida (olvido de salida). */
export async function jornadasIncompletas(schemaRaw: string, empresaId: string): Promise<JornadaIncompleta[]> {
  const { E, EV } = t(schemaRaw);
  const { rows } = await pool().query<JornadaIncompleta>(
    `WITH j AS (
       SELECT empleado_id, jornada, bool_or(tipo = 'salida') AS cerrada,
              max(momento) AS ultima_m,
              (array_agg(tipo ORDER BY momento DESC))[1] AS ultimo_tipo
         FROM ${EV}
        WHERE empresa_id = $1::uuid AND NOT anulado
          AND jornada >= (now() AT TIME ZONE '${ZONA}')::date - 45
        GROUP BY empleado_id, jornada
     )
     SELECT j.empleado_id, e.nombre AS empleado, j.jornada::text AS jornada,
            to_char(j.ultima_m AT TIME ZONE '${ZONA}', 'HH24:MI') AS ultima, j.ultimo_tipo
       FROM j JOIN ${E} e ON e.id = j.empleado_id
      WHERE NOT j.cerrada AND j.jornada < (now() AT TIME ZONE '${ZONA}')::date
      ORDER BY j.jornada DESC, e.nombre`,
    [empresaId]
  );
  return rows;
}

export type DetalleDia = {
  empleado: { id: string; nombre: string };
  jornada: string;
  eventos: { id: string; tipo: TipoEvento; hora: string; origen: string; sesion_usuario_nombre: string | null; anulado: boolean }[];
  correcciones: { accion: string; antes: unknown; despues: unknown; motivo: string; usuario_nombre: string | null; cuando: string }[];
};

export async function detalleDia(schemaRaw: string, empresaId: string, empleadoId: string, jornadaRaw: string): Promise<DetalleDia> {
  const { E, EV, C } = t(schemaRaw);
  const emp = await pool().query<{ id: string; nombre: string }>(
    `SELECT id, nombre FROM ${E} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [empleadoId, empresaId]
  );
  if (!emp.rows[0]) throw new AsistenciaError("Empleado no encontrado.", 404);
  const eventos = await pool().query<DetalleDia["eventos"][number]>(
    `SELECT id, tipo, to_char(momento AT TIME ZONE '${ZONA}', 'HH24:MI') AS hora, origen, sesion_usuario_nombre, anulado
       FROM ${EV} WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND jornada = $3::date
      ORDER BY momento, created_at`,
    [empresaId, empleadoId, jornadaRaw]
  );
  const correcciones = await pool().query<DetalleDia["correcciones"][number]>(
    `SELECT accion, antes, despues, motivo, usuario_nombre,
            to_char(created_at AT TIME ZONE '${ZONA}', 'DD/MM HH24:MI') AS cuando
       FROM ${C} WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND jornada = $3::date
      ORDER BY created_at DESC`,
    [empresaId, empleadoId, jornadaRaw]
  );
  return { empleado: emp.rows[0], jornada: jornadaRaw, eventos: eventos.rows, correcciones: correcciones.rows };
}

export type Correccion =
  | { accion: "agregar"; tipo: TipoEvento; hora: string }
  | { accion: "modificar"; eventoId: string; hora: string }
  | { accion: "anular"; eventoId: string };

/**
 * Corrección de un administrador sobre un día de un empleado. Motivo
 * obligatorio; queda quién, cuándo y el valor anterior y el nuevo. La
 * secuencia resultante tiene que tener sentido (no un fin de break sin inicio).
 */
export async function corregir(
  schemaRaw: string,
  empresaId: string,
  empleadoId: string,
  jornada: string,
  cor: Correccion,
  motivoRaw: unknown,
  usuario: { id: string | null; nombre: string | null }
): Promise<void> {
  const motivo = String(motivoRaw ?? "").trim();
  if (motivo.length < 3) throw new AsistenciaError("Escribí el motivo de la corrección.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jornada)) throw new AsistenciaError("Fecha inválida.");
  const { E, EV, C } = t(schemaRaw);
  const client = await pool().connect();
  const c = client as unknown as Q;
  const aMomento = (hora: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new AsistenciaError("Hora inválida. Formato HH:MM.");
    return `(($1::date + $2::time) AT TIME ZONE '${ZONA}')`;
  };
  try {
    await client.query("BEGIN");
    const emp = await c.query<{ horario_entrada: string | null }>(
      `SELECT to_char(horario_entrada, 'HH24:MI') AS horario_entrada FROM ${E}
        WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [empleadoId, empresaId]
    );
    if (!emp.rows[0]) throw new AsistenciaError("Empleado no encontrado.", 404);

    let eventoId: string | null = null;
    let antes: unknown = null;
    let despues: unknown = null;
    if (cor.accion === "agregar") {
      if (!(TIPOS_EVENTO as readonly string[]).includes(cor.tipo)) throw new AsistenciaError("Tipo de marcación inválido.");
      const expr = aMomento(cor.hora);
      const r = await c.query<{ id: string }>(
        `INSERT INTO ${EV} (empresa_id, empleado_id, jornada, tipo, momento, origen, sesion_usuario_id, sesion_usuario_nombre)
         VALUES ($3::uuid, $4::uuid, $1::date, $5, ${expr}, 'admin', $6::uuid, $7) RETURNING id`,
        [jornada, cor.hora, empresaId, empleadoId, cor.tipo, usuario.id, usuario.nombre]
      );
      eventoId = r.rows[0].id;
      despues = { tipo: cor.tipo, hora: cor.hora };
    } else {
      const ev = await c.query<{ id: string; tipo: TipoEvento; hora: string; anulado: boolean }>(
        `SELECT id, tipo, to_char(momento AT TIME ZONE '${ZONA}', 'HH24:MI') AS hora, anulado FROM ${EV}
          WHERE id = $1::uuid AND empresa_id = $2::uuid AND empleado_id = $3::uuid AND jornada = $4::date`,
        [cor.eventoId, empresaId, empleadoId, jornada]
      );
      const e = ev.rows[0];
      if (!e) throw new AsistenciaError("Marcación no encontrada.", 404);
      if (e.anulado) throw new AsistenciaError("Esa marcación ya está anulada.", 409);
      eventoId = e.id;
      antes = { tipo: e.tipo, hora: e.hora };
      if (cor.accion === "modificar") {
        const expr = aMomento(cor.hora);
        await c.query(`UPDATE ${EV} SET momento = ${expr} WHERE id = $3::uuid`, [jornada, cor.hora, e.id]);
        despues = { tipo: e.tipo, hora: cor.hora };
      } else {
        await c.query(`UPDATE ${EV} SET anulado = true WHERE id = $1::uuid`, [e.id]);
        despues = { anulado: true };
      }
    }

    // La secuencia del día tiene que seguir teniendo sentido.
    const evs = (
      await c.query<{ tipo: TipoEvento }>(
        `SELECT tipo FROM ${EV} WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND jornada = $3::date AND NOT anulado
          ORDER BY momento, created_at`,
        [empresaId, empleadoId, jornada]
      )
    ).rows;
    const problema = secuenciaValida(evs);
    if (problema) throw new AsistenciaError(`${problema} Revisá las horas.`, 409);

    await c.query(
      `INSERT INTO ${C} (empresa_id, empleado_id, evento_id, jornada, accion, antes, despues, motivo, usuario_id, usuario_nombre)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::jsonb, $7::jsonb, $8, $9::uuid, $10)`,
      [empresaId, empleadoId, eventoId, jornada, cor.accion, JSON.stringify(antes), JSON.stringify(despues), motivo.slice(0, 300), usuario.id, usuario.nombre]
    );
    await resincronizarDia(c, schemaRaw, empresaId, empleadoId, jornada, emp.rows[0].horario_entrada);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

/** Marcaciones en CSV para Excel (separador `;`, BOM para los acentos). */
export function marcacionesCsv(filas: MarcacionFila[]): string {
  const celda = (v: string | null | undefined) => {
    const s = v ?? "";
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cab = ["Fecha", "Hora", "Empleado", "Cédula", "Código", "Marcación", "Origen", "Sesión", "Anulada", "Corregida"];
  const lineas = filas.map((f) =>
    [
      f.jornada.split("-").reverse().join("/"), f.hora, f.empleado, f.documento, f.codigo, ETIQUETA_EVENTO[f.tipo],
      f.origen, f.sesion_usuario_nombre, f.anulado ? "Sí" : "", f.corregido ? "Sí" : "",
    ].map((v) => celda(v)).join(";")
  );
  return "﻿" + [cab.join(";"), ...lineas].join("\r\n");
}
