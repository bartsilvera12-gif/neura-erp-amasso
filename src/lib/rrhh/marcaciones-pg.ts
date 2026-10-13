import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { AsistenciaError, ZONA, estadoPorEntrada } from "./asistencia-pg";
import { CONFIG_RRHH_DEFECTO, leerConfig, type ConfigRrhh } from "./config-pg";
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

// ─── Reglas (salen de RRHH › Configuración) ───────────────────────────────

/** Lo que define qué se puede marcar después de qué. */
type Reglas = {
  breaksMax: number | null;
  almuerzo: boolean;
  /** Salida directa desde un break o almuerzo (se cierra la pausa con aviso). */
  salidaDesdePausa: boolean;
  reingreso: boolean;
};

const reglasDe = (cfg: ConfigRrhh): Reglas => ({
  breaksMax: cfg.descansos.breaks_max,
  almuerzo: cfg.descansos.almuerzo,
  salidaDesdePausa: cfg.excepciones.salida_con_pausa === "cerrar_y_avisar",
  reingreso: cfg.excepciones.reingreso,
});

/**
 * Para las correcciones del administrador solo importa que la secuencia tenga
 * sentido: no se aplican los topes de breaks (puede estar cargando lo que pasó).
 */
const reglasDeCorreccion = (cfg: ConfigRrhh): Reglas => ({
  breaksMax: null,
  almuerzo: true,
  salidaDesdePausa: false,
  reingreso: cfg.excepciones.reingreso,
});

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
  /** Hubo una jornada anterior sin salida que quedó abandonada. */
  jornadaAnteriorIncompleta: string | null;
  /** Inicio de la pausa abierta (segundos desde 1970), para medir cuánto duró. */
  pausaDesde: number | null;
};

function estadoTrasEvento(tipo: TipoEvento): EstadoJornada {
  switch (tipo) {
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

const estadoDesdeEventos = (evs: { tipo: TipoEvento }[]): EstadoJornada =>
  evs.length ? estadoTrasEvento(evs[evs.length - 1].tipo) : "sin_entrada";

function accionesPara(estado: EstadoJornada, usados: { breaks: number; almuerzos: number }, r: Reglas): TipoEvento[] {
  switch (estado) {
    case "sin_entrada":
      return ["entrada"];
    case "trabajando": {
      const a: TipoEvento[] = [];
      if (r.breaksMax == null || usados.breaks < r.breaksMax) a.push("inicio_break");
      if (r.almuerzo && usados.almuerzos === 0) a.push("inicio_almuerzo");
      a.push("salida");
      return a;
    }
    case "en_break":
      return r.salidaDesdePausa ? ["fin_break", "salida"] : ["fin_break"];
    case "en_almuerzo":
      return r.salidaDesdePausa ? ["fin_almuerzo", "salida"] : ["fin_almuerzo"];
    case "cerrada":
      return r.reingreso ? ["entrada"] : [];
  }
}

const contarUsados = (evs: { tipo: TipoEvento }[]) => ({
  breaks: evs.filter((e) => e.tipo === "inicio_break").length,
  almuerzos: evs.filter((e) => e.tipo === "inicio_almuerzo").length,
});

async function eventosDelDia(c: Q, schemaRaw: string, empresaId: string, empleadoId: string, jornada: string): Promise<Evento[]> {
  const { EV } = t(schemaRaw);
  return (
    await c.query<Evento>(
      `SELECT ${COLS_EVENTO} FROM ${EV}
        WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND jornada = $3::date AND NOT anulado
        ORDER BY momento, created_at`,
      [empresaId, empleadoId, jornada]
    )
  ).rows;
}

async function estadoDe(
  c: Q,
  schemaRaw: string,
  empresaId: string,
  empleadoId: string,
  cfg: ConfigRrhh
): Promise<EstadoActual> {
  const { EV } = t(schemaRaw);
  const reglas = reglasDe(cfg);
  const nueva = (anterior: string | null): EstadoActual => ({
    estado: "sin_entrada",
    jornada: null,
    acciones: ["entrada"],
    jornadaAnteriorIncompleta: anterior,
    pausaDesde: null,
  });
  const hoy = await hoyPY(c);
  // Última jornada con marcaciones válidas.
  const ult = await c.query<{ jornada: string; horas: number }>(
    `SELECT jornada::text AS jornada, extract(epoch FROM now() - min(momento))::float8 / 3600 AS horas FROM ${EV}
      WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND NOT anulado
      GROUP BY jornada ORDER BY jornada DESC LIMIT 1`,
    [empresaId, empleadoId]
  );
  const j = ult.rows[0];
  if (!j) return nueva(null);
  const evs = await eventosDelDia(c, schemaRaw, empresaId, empleadoId, j.jornada);
  const estado = estadoDesdeEventos(evs);

  // Jornada cerrada de un día anterior: empieza otra.
  if (estado === "cerrada" && j.jornada < hoy) return nueva(null);
  // Jornada abierta y abandonada (olvido de salida). Con jornada nocturna se
  // espera hasta el máximo de horas; sin ella, cada día empieza una nueva.
  const abandonada = cfg.horario.jornada_nocturna ? Number(j.horas) > cfg.horario.horas_max_jornada : j.jornada < hoy;
  if (estado !== "cerrada" && abandonada) return nueva(j.jornada);

  const ultimo = evs[evs.length - 1];
  return {
    estado,
    jornada: j.jornada,
    acciones: accionesPara(estado, contarUsados(evs), reglas),
    jornadaAnteriorIncompleta: null,
    pausaDesde: estado === "en_break" || estado === "en_almuerzo" ? Number(ultimo.ep) : null,
  };
}

// ─── Identificación ───────────────────────────────────────────────────────

export type Credenciales = { cedula?: unknown; codigo?: unknown; pin?: unknown };
export type EmpleadoIdentificado = { id: string; nombre: string; horario_entrada: string | null; horario_salida: string | null };

const normalizarDoc = (v: unknown) => String(v ?? "").replace(/[.\s-]/g, "").trim().toUpperCase();

async function registrarIntento(c: Q, schemaRaw: string, empresaId: string, clave: string, exitoso: boolean) {
  const { I } = t(schemaRaw);
  await c.query(`INSERT INTO ${I} (empresa_id, clave, exitoso) VALUES ($1::uuid, $2, $3)`, [empresaId, clave, exitoso]);
}

/**
 * Valida cédula + código, y el PIN según la configuración (desactivado,
 * opcional por empleado u obligatorio). El mensaje de error no dice cuál de los
 * datos está mal. Cinco fallos en diez minutos desde la misma sesión bloquean
 * los intentos un rato.
 */
async function identificarEn(
  c: Q,
  schemaRaw: string,
  empresaId: string,
  cred: Credenciales,
  claveSesion: string,
  cfg: ConfigRrhh
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

  const r = await c.query<{ id: string; nombre: string; pin_hash: string | null; horario_entrada: string | null; horario_salida: string | null }>(
    `SELECT id, nombre, pin_hash, to_char(horario_entrada, 'HH24:MI') AS horario_entrada,
            to_char(horario_salida, 'HH24:MI') AS horario_salida FROM ${E}
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
  const modoPin = cfg.autenticacion.pin;
  if (modoPin === "obligatorio" && !emp.pin_hash) {
    throw new AsistenciaError("Para marcar necesitás un PIN. Pedile a administración que te asigne uno.", 403);
  }
  if (modoPin !== "desactivado" && emp.pin_hash) {
    const pin = String(cred.pin ?? "").trim();
    if (!pin) return { requierePin: true };
    if (!verificarPin(pin, emp.pin_hash)) {
      await registrarIntento(c, schemaRaw, empresaId, claveSesion, false);
      throw new AsistenciaError("El PIN no es correcto.", 401);
    }
  }
  await registrarIntento(c, schemaRaw, empresaId, claveSesion, true);
  return {
    empleado: { id: emp.id, nombre: emp.nombre, horario_entrada: emp.horario_entrada, horario_salida: emp.horario_salida },
  };
}

export type RespuestaIdentificar =
  | { requiere_pin: true }
  | { requiere_pin: false; nombre: string; estado: EstadoJornada; acciones: TipoEvento[]; aviso: string | null };

const fechaCorta = (f: string) => f.split("-").reverse().join("/");

export async function identificar(
  schemaRaw: string,
  empresaId: string,
  cred: Credenciales,
  claveSesion: string
): Promise<RespuestaIdentificar> {
  const c = pool() as unknown as Q;
  const cfg = await leerConfig(schemaRaw, empresaId);
  const id = await identificarEn(c, schemaRaw, empresaId, cred, claveSesion, cfg);
  if ("requierePin" in id) return { requiere_pin: true };
  const est = await estadoDe(c, schemaRaw, empresaId, id.empleado.id, cfg);
  let aviso: string | null = null;
  if (est.estado === "cerrada") {
    aviso = est.acciones.includes("entrada")
      ? "Ya marcaste la salida. Si volvés a trabajar hoy, marcá Entrada."
      : "Tu jornada de hoy ya está cerrada. La próxima marcación es la entrada de mañana.";
  } else if (est.jornadaAnteriorIncompleta) {
    aviso =
      cfg.excepciones.olvido_salida === "cerrar_en_horario"
        ? `Tu jornada del ${fechaCorta(est.jornadaAnteriorIncompleta)} quedó sin salida: se va a cerrar a tu hora de salida.`
        : `Tu jornada del ${fechaCorta(est.jornadaAnteriorIncompleta)} quedó sin salida. Avisale a administración para corregirla.`;
  } else if (est.estado === "en_break" || est.estado === "en_almuerzo") {
    if (!est.acciones.includes("salida")) aviso = `Para marcar la salida, primero terminá ${est.estado === "en_break" ? "el break" : "el almuerzo"}.`;
  }
  return { requiere_pin: false, nombre: id.empleado.nombre, estado: est.estado, acciones: est.acciones, aviso };
}

// ─── Marcar ───────────────────────────────────────────────────────────────

export type ResultadoMarcacion = { nombre: string; tipo: TipoEvento; etiqueta: string; hora: string; aviso: string | null };

/** Aviso si la pausa que se cierra pasó el máximo configurado. */
function avisoDePausa(est: EstadoActual, ahoraEp: number, cfg: ConfigRrhh): string | null {
  if (est.pausaDesde == null) return null;
  const min = Math.round((ahoraEp - est.pausaDesde) / 60);
  const max = est.estado === "en_break" ? cfg.descansos.break_max_min : cfg.descansos.almuerzo_max_min;
  if (max == null || min <= max) return null;
  return `${est.estado === "en_break" ? "El break" : "El almuerzo"} duró ${min} min; el máximo es ${max} min. Queda registrado.`;
}

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
  const cfg = await leerConfig(schemaRaw, empresaId);
  const client = await pool().connect();
  const c = client as unknown as Q;
  try {
    await client.query("BEGIN");
    const id = await identificarEn(c, schemaRaw, empresaId, cred, sesion.clave, cfg);
    if ("requierePin" in id) throw new AsistenciaError("Ingresá tu PIN.", 401);
    // Bloqueo del empleado: dos marcaciones a la vez se hacen una después de otra.
    await c.query(`SELECT id FROM ${E} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [id.empleado.id, empresaId]);
    const est = await estadoDe(c, schemaRaw, empresaId, id.empleado.id, cfg);
    if (!est.acciones.includes(tipo)) {
      throw new AsistenciaError(
        est.estado === "cerrada"
          ? "Tu jornada de hoy ya está cerrada."
          : `No corresponde marcar ${ETIQUETA_EVENTO[tipo].toLowerCase()} ahora. Lo que podés marcar: ${est.acciones.map((a) => ETIQUETA_EVENTO[a]).join(", ")}.`,
        409
      );
    }
    const hoy = await hoyPY(c);
    // Entrada: jornada nueva (hoy), salvo un reingreso, que sigue en la misma.
    const jornada = tipo === "entrada" && est.estado !== "cerrada" ? hoy : est.jornada ?? hoy;
    const ahora = await c.query<{ h: string; ep: number }>(
      `SELECT to_char(now() AT TIME ZONE '${ZONA}', 'HH24:MI') AS h, extract(epoch FROM now())::float8 AS ep`
    );
    const avisos: string[] = [];
    const ins = async (tp: TipoEvento) =>
      c.query(
        `INSERT INTO ${EV} (empresa_id, empleado_id, jornada, tipo, origen, sesion_usuario_id, sesion_usuario_nombre, dispositivo)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, 'autoservicio', $5::uuid, $6, $7)`,
        [empresaId, id.empleado.id, jornada, tp, sesion.usuarioId, sesion.usuarioNombre, sesion.dispositivo?.slice(0, 200) ?? null]
      );
    // Salida con una pausa abierta (si la configuración lo permite): se cierra la pausa en el mismo momento.
    if (tipo === "salida" && (est.estado === "en_break" || est.estado === "en_almuerzo")) {
      await ins(est.estado === "en_break" ? "fin_break" : "fin_almuerzo");
      avisos.push(`Tenías ${est.estado === "en_break" ? "un break" : "el almuerzo"} abierto: se cerró con la salida.`);
    }
    const excedida = avisoDePausa(est, Number(ahora.rows[0].ep), cfg);
    if (excedida) avisos.push(excedida);
    await ins(tipo);
    // Jornada anterior abandonada: se cierra sola o queda incompleta, según la configuración.
    if (est.jornadaAnteriorIncompleta) {
      const cerrada =
        cfg.excepciones.olvido_salida === "cerrar_en_horario" &&
        (await cerrarPorOlvido(c, schemaRaw, empresaId, id.empleado, est.jornadaAnteriorIncompleta, cfg));
      if (!cerrada) await resincronizarDia(c, schemaRaw, empresaId, id.empleado.id, est.jornadaAnteriorIncompleta, id.empleado.horario_entrada, cfg);
    }
    await resincronizarDia(c, schemaRaw, empresaId, id.empleado.id, jornada, id.empleado.horario_entrada, cfg);
    await client.query("COMMIT");
    return { nombre: id.empleado.nombre, tipo, etiqueta: ETIQUETA_EVENTO[tipo], hora: ahora.rows[0].h, aviso: avisos.join(" ") || null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Olvido de salida con "cerrar a la hora de salida": agrega la salida (y el
 * fin de la pausa abierta, si había) a la hora de salida del empleado, como una
 * corrección del sistema con su motivo. Si el empleado no tiene hora de salida
 * o esa hora es anterior a su última marcación, no se puede: queda incompleta.
 */
async function cerrarPorOlvido(
  c: Q,
  schemaRaw: string,
  empresaId: string,
  emp: { id: string; horario_entrada: string | null; horario_salida: string | null },
  jornada: string,
  cfg: ConfigRrhh
): Promise<boolean> {
  if (!emp.horario_salida) return false;
  const { EV, C } = t(schemaRaw);
  const evs = await eventosDelDia(c, schemaRaw, empresaId, emp.id, jornada);
  const ultimo = evs[evs.length - 1];
  if (!ultimo || ultimo.tipo === "salida") return false;
  // Turno nocturno (sale antes de la hora a la que entra): la salida es al día siguiente.
  const cruza = !!emp.horario_entrada && emp.horario_salida <= emp.horario_entrada;
  const m = await c.query<{ momento: string; ep: number }>(
    `SELECT x::text AS momento, extract(epoch FROM x)::float8 AS ep
       FROM (SELECT ((($1::date + ($3 || ' days')::interval)::date + $2::time) AT TIME ZONE '${ZONA}') AS x) s`,
    [jornada, emp.horario_salida, cruza ? "1" : "0"]
  );
  const salida = m.rows[0];
  if (Number(salida.ep) <= Number(ultimo.ep)) return false;
  const pausa = estadoDesdeEventos(evs);
  const motivo = "Cierre automático por olvido de salida (RRHH › Configuración).";
  const agregar = async (tipo: TipoEvento) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO ${EV} (empresa_id, empleado_id, jornada, tipo, momento, origen, sesion_usuario_nombre)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::timestamptz, 'admin', 'Automático') RETURNING id`,
      [empresaId, emp.id, jornada, tipo, salida.momento]
    );
    await c.query(
      `INSERT INTO ${C} (empresa_id, empleado_id, evento_id, jornada, accion, antes, despues, motivo, usuario_nombre)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 'agregar', NULL, $5::jsonb, $6, 'Sistema')`,
      [empresaId, emp.id, r.rows[0].id, jornada, JSON.stringify({ tipo, hora: emp.horario_salida }), motivo]
    );
  };
  if (pausa === "en_break") await agregar("fin_break");
  if (pausa === "en_almuerzo") await agregar("fin_almuerzo");
  await agregar("salida");
  await resincronizarDia(c, schemaRaw, empresaId, emp.id, jornada, emp.horario_entrada, cfg);
  return true;
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

/** Tiempo entre cada salida y el reingreso siguiente, en minutos. */
function minutosFuera(evs: Evento[]): number {
  let total = 0;
  let salida: number | null = null;
  for (const e of evs) {
    if (e.tipo === "salida") salida = Number(e.ep);
    else if (e.tipo === "entrada" && salida != null) {
      total += (Number(e.ep) - salida) / 60;
      salida = null;
    }
  }
  return Math.round(total);
}

/** Valida que la secuencia de un día tenga sentido (para correcciones). */
export function secuenciaValida(evs: { tipo: TipoEvento }[], cfg: ConfigRrhh = CONFIG_RRHH_DEFECTO): string | null {
  const reglas = reglasDeCorreccion(cfg);
  let estado: EstadoJornada = "sin_entrada";
  const usados = { breaks: 0, almuerzos: 0 };
  let anterior: TipoEvento | null = null;
  for (const e of evs) {
    const permitidas = accionesPara(estado, usados, reglas);
    if (!permitidas.includes(e.tipo)) {
      if (e.tipo === "inicio_almuerzo" && usados.almuerzos > 0) return "Solo puede haber un almuerzo por jornada.";
      if (e.tipo === "entrada" && estado === "cerrada") {
        return "Después de la salida no puede haber otra entrada el mismo día (el reingreso está desactivado en la configuración).";
      }
      return anterior
        ? `La secuencia no cierra: “${ETIQUETA_EVENTO[e.tipo]}” no puede ir después de “${ETIQUETA_EVENTO[anterior]}”.`
        : `La jornada tiene que empezar con una entrada, no con “${ETIQUETA_EVENTO[e.tipo]}”.`;
    }
    if (e.tipo === "inicio_break") usados.breaks++;
    if (e.tipo === "inicio_almuerzo") usados.almuerzos++;
    estado = estadoTrasEvento(e.tipo);
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
  horarioEntrada: string | null,
  cfg: ConfigRrhh
) {
  const { A } = t(schemaRaw);
  const evs = await eventosDelDia(c, schemaRaw, empresaId, empleadoId, jornada);
  const entrada = evs.find((e) => e.tipo === "entrada");
  // La salida cuenta solo si es lo último: con un reingreso en curso no hay salida todavía.
  const ultimo = evs[evs.length - 1];
  const salida = ultimo?.tipo === "salida" ? ultimo : null;
  if (!entrada) {
    // Sin marcaciones válidas: si el día existía solo por las marcaciones, se
    // vuelve a "sin marcar". Un estado puesto a mano (permiso, vacaciones…) queda.
    await c.query(
      `DELETE FROM ${A} WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND fecha = $3::date
          AND estado IN ('presente', 'tarde')`,
      [empresaId, empleadoId, jornada]
    );
    await c.query(
      `UPDATE ${A} SET hora_entrada = NULL, hora_salida = NULL, minutos_break = 0, minutos_almuerzo = 0, minutos_fuera = 0,
              incompleta = false, updated_at = now()
        WHERE empresa_id = $1::uuid AND empleado_id = $2::uuid AND fecha = $3::date`,
      [empresaId, empleadoId, jornada]
    );
    return;
  }
  const hora = await c.query<{ h: string }>(`SELECT to_char($1::timestamptz AT TIME ZONE '${ZONA}', 'HH24:MI') AS h`, [entrada.momento]);
  const estado = estadoPorEntrada(hora.rows[0].h, horarioEntrada, cfg.horario);
  const hoy = await hoyPY(c);
  const incompleta = !salida && jornada < hoy;
  await c.query(
    `INSERT INTO ${A} (empresa_id, empleado_id, fecha, estado, hora_entrada, hora_salida, minutos_break, minutos_almuerzo,
                       minutos_fuera, incompleta, justificada)
     VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10, NULL)
     ON CONFLICT ON CONSTRAINT asistencias_un_registro_por_dia DO UPDATE SET
       estado = EXCLUDED.estado, hora_entrada = EXCLUDED.hora_entrada, hora_salida = EXCLUDED.hora_salida,
       minutos_break = EXCLUDED.minutos_break, minutos_almuerzo = EXCLUDED.minutos_almuerzo,
       minutos_fuera = EXCLUDED.minutos_fuera, incompleta = EXCLUDED.incompleta, justificada = NULL, updated_at = now()`,
    [
      empresaId, empleadoId, jornada, estado, entrada.momento, salida?.momento ?? null,
      minutosDePausa(evs, "inicio_break", "fin_break"), minutosDePausa(evs, "inicio_almuerzo", "fin_almuerzo"),
      minutosFuera(evs), incompleta,
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
/**
 * Jornadas que quedaron sin salida (olvido de salida). Una jornada en curso no
 * cuenta: con jornada nocturna se espera hasta el máximo de horas configurado.
 * Si la configuración dice "cerrar a la hora de salida", se cierran acá mismo y
 * solo quedan las que no se pudieron cerrar (empleado sin hora de salida).
 */
export async function jornadasIncompletas(schemaRaw: string, empresaId: string): Promise<JornadaIncompleta[]> {
  const { E, EV } = t(schemaRaw);
  const cfg = await leerConfig(schemaRaw, empresaId);
  const abandonada = cfg.horario.jornada_nocturna
    ? `j.primera_m < now() - interval '${cfg.horario.horas_max_jornada} hours'`
    : `j.jornada < (now() AT TIME ZONE '${ZONA}')::date`;
  const consultar = async () =>
    (
      await pool().query<JornadaIncompleta & { horario_entrada: string | null; horario_salida: string | null }>(
        `WITH j AS (
           SELECT empleado_id, jornada, min(momento) AS primera_m, max(momento) AS ultima_m,
                  (array_agg(tipo ORDER BY momento DESC, created_at DESC))[1] AS ultimo_tipo
             FROM ${EV}
            WHERE empresa_id = $1::uuid AND NOT anulado
              AND jornada >= (now() AT TIME ZONE '${ZONA}')::date - 45
            GROUP BY empleado_id, jornada
         )
         SELECT j.empleado_id, e.nombre AS empleado, j.jornada::text AS jornada,
                to_char(j.ultima_m AT TIME ZONE '${ZONA}', 'HH24:MI') AS ultima, j.ultimo_tipo,
                to_char(e.horario_entrada, 'HH24:MI') AS horario_entrada, to_char(e.horario_salida, 'HH24:MI') AS horario_salida
           FROM j JOIN ${E} e ON e.id = j.empleado_id
          WHERE j.ultimo_tipo <> 'salida' AND ${abandonada}
          ORDER BY j.jornada DESC, e.nombre`,
        [empresaId]
      )
    ).rows;
  let filas = await consultar();
  if (cfg.excepciones.olvido_salida === "cerrar_en_horario" && filas.some((f) => f.horario_salida)) {
    for (const f of filas) {
      if (!f.horario_salida) continue;
      const client = await pool().connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT id FROM ${E} WHERE id = $1::uuid FOR UPDATE`, [f.empleado_id]);
        await cerrarPorOlvido(client as unknown as Q, schemaRaw, empresaId, { id: f.empleado_id, horario_entrada: f.horario_entrada, horario_salida: f.horario_salida }, f.jornada, cfg);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => null);
        throw err;
      } finally {
        client.release();
      }
    }
    filas = await consultar();
  }
  return filas.map(({ empleado_id, empleado, jornada, ultima, ultimo_tipo }) => ({ empleado_id, empleado, jornada, ultima, ultimo_tipo }));
}

export type DetalleDia = {
  empleado: { id: string; nombre: string };
  jornada: string;
  eventos: { id: string; tipo: TipoEvento; hora: string; origen: string; sesion_usuario_nombre: string | null; anulado: boolean }[];
  correcciones: { accion: string; antes: unknown; despues: unknown; motivo: string; usuario_nombre: string | null; cuando: string }[];
  /** Totales del día con las reglas de la configuración. */
  totales: { trabajado_min: number | null; break_min: number; almuerzo_min: number; fuera_min: number; avisos: string[] };
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
  const cfg = await leerConfig(schemaRaw, empresaId);
  const validos = await eventosDelDia(pool() as unknown as Q, schemaRaw, empresaId, empleadoId, jornadaRaw);
  const break_min = minutosDePausa(validos, "inicio_break", "fin_break");
  const almuerzo_min = minutosDePausa(validos, "inicio_almuerzo", "fin_almuerzo");
  const fuera_min = minutosFuera(validos);
  const primera = validos.find((e) => e.tipo === "entrada");
  const ultimo = validos[validos.length - 1];
  const trabajado_min =
    primera && ultimo?.tipo === "salida"
      ? Math.round((Number(ultimo.ep) - Number(primera.ep)) / 60) -
        (cfg.descansos.descontar_break ? break_min : 0) -
        (cfg.descansos.descontar_almuerzo ? almuerzo_min : 0) -
        fuera_min
      : null;
  const avisos: string[] = [];
  // Pausas que pasaron el máximo configurado.
  let desde: number | null = null;
  for (const e of validos) {
    if (e.tipo === "inicio_break" || e.tipo === "inicio_almuerzo") desde = Number(e.ep);
    if ((e.tipo === "fin_break" || e.tipo === "fin_almuerzo") && desde != null) {
      const min = Math.round((Number(e.ep) - desde) / 60);
      const esBreak = e.tipo === "fin_break";
      const max = esBreak ? cfg.descansos.break_max_min : cfg.descansos.almuerzo_max_min;
      if (max != null && min > max) avisos.push(`${esBreak ? "Un break" : "El almuerzo"} duró ${min} min (máximo ${max}).`);
      desde = null;
    }
  }
  return {
    empleado: emp.rows[0],
    jornada: jornadaRaw,
    eventos: eventos.rows,
    correcciones: correcciones.rows,
    totales: { trabajado_min, break_min, almuerzo_min, fuera_min, avisos },
  };
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
    const cfg = await leerConfig(schemaRaw, empresaId);
    const problema = secuenciaValida(evs, cfg);
    if (problema) throw new AsistenciaError(`${problema} Revisá las horas.`, 409);

    await c.query(
      `INSERT INTO ${C} (empresa_id, empleado_id, evento_id, jornada, accion, antes, despues, motivo, usuario_id, usuario_nombre)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::jsonb, $7::jsonb, $8, $9::uuid, $10)`,
      [empresaId, empleadoId, eventoId, jornada, cor.accion, JSON.stringify(antes), JSON.stringify(despues), motivo.slice(0, 300), usuario.id, usuario.nombre]
    );
    await resincronizarDia(c, schemaRaw, empresaId, empleadoId, jornada, emp.rows[0].horario_entrada, cfg);
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
