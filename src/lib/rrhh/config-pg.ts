import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { AsistenciaError } from "./errores";
import { CONFIG_RRHH_DEFECTO, type ConfigRrhh, type AccesoModulo } from "./config-tipos";

export { CONFIG_RRHH_DEFECTO };
export type { ConfigRrhh, AccesoModulo };

/**
 * Configuración de asistencia de la empresa (RRHH › Configuración).
 *
 * Son las decisiones del punto 6 de la especificación de Amasso. Se guarda una
 * fila por empresa en `rrhh_configuracion` (script 15). Sin fila, o con campos
 * que falten, valen los valores por defecto: lo que el sistema hacía antes de
 * que esto fuera configurable.
 *
 * Se cachea unos segundos por proceso: se lee en cada marcación y en cada
 * pantalla, y cambia muy de vez en cuando.
 */

const CACHE_MS = 15_000;
const cache = new Map<string, { hasta: number; config: ConfigRrhh }>();

const ACCESOS: AccesoModulo[] = ["nadie", "admin", "todos"];

function entero(v: unknown, min: number, max: number, defecto: number | null): number | null {
  if (v == null || v === "") return defecto;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return defecto;
  return Math.min(max, Math.max(min, n));
}

const uno = <T extends string>(v: unknown, opciones: readonly T[], defecto: T): T =>
  (opciones as readonly unknown[]).includes(v) ? (v as T) : defecto;

const bool = (v: unknown, defecto: boolean) => (typeof v === "boolean" ? v : defecto);

/** Completa y sanea lo que venga (de la base o del formulario). */
export function normalizarConfig(raw: unknown): ConfigRrhh {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const d = CONFIG_RRHH_DEFECTO;
  const m = r.modulos ?? {};
  const h = r.horario ?? {};
  const de = r.descansos ?? {};
  const ex = r.excepciones ?? {};
  const au = r.autenticacion ?? {};
  const di = r.dispositivos ?? {};
  return {
    modulos: {
      gestion_clientes: uno(m.gestion_clientes, ACCESOS, d.modulos.gestion_clientes),
      bancos: uno(m.bancos, ACCESOS, d.modulos.bancos),
    },
    horario: {
      modo: uno(h.modo, ["fijo", "libre"] as const, d.horario.modo),
      tolerancia_min: entero(h.tolerancia_min, 0, 120, d.horario.tolerancia_min)!,
      jornada_nocturna: bool(h.jornada_nocturna, d.horario.jornada_nocturna),
      horas_max_jornada: entero(h.horas_max_jornada, 4, 36, d.horario.horas_max_jornada)!,
    },
    descansos: {
      breaks_max: entero(de.breaks_max, 0, 20, null),
      break_max_min: entero(de.break_max_min, 1, 600, null),
      almuerzo: bool(de.almuerzo, d.descansos.almuerzo),
      almuerzo_max_min: entero(de.almuerzo_max_min, 1, 600, null),
      descontar_break: bool(de.descontar_break, d.descansos.descontar_break),
      descontar_almuerzo: bool(de.descontar_almuerzo, d.descansos.descontar_almuerzo),
    },
    excepciones: {
      salida_con_pausa: uno(ex.salida_con_pausa, ["cerrar_y_avisar", "bloquear"] as const, d.excepciones.salida_con_pausa),
      olvido_salida: uno(ex.olvido_salida, ["incompleta", "cerrar_en_horario"] as const, d.excepciones.olvido_salida),
      reingreso: bool(ex.reingreso, d.excepciones.reingreso),
    },
    autenticacion: {
      pin: uno(au.pin, ["desactivado", "opcional", "obligatorio"] as const, d.autenticacion.pin),
    },
    dispositivos: {
      boton_en_barra: bool(di.boton_en_barra, d.dispositivos.boton_en_barra),
      terminal: bool(di.terminal, d.dispositivos.terminal),
    },
  };
}

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new AsistenciaError("No hay conexión directa a Postgres.", 500);
  return p;
}

export async function leerConfig(schemaRaw: string, empresaId: string): Promise<ConfigRrhh> {
  const clave = `${schemaRaw}:${empresaId}`;
  const c = cache.get(clave);
  if (c && c.hasta > Date.now()) return c.config;
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "rrhh_configuracion");
  let config: ConfigRrhh;
  try {
    const r = await pool().query<{ config: unknown }>(`SELECT config FROM ${t} WHERE empresa_id = $1::uuid`, [empresaId]);
    config = normalizarConfig(r.rows[0]?.config);
  } catch (err) {
    // Tabla todavía no creada (script 15 sin correr): valores por defecto.
    if ((err as { code?: string })?.code === "42P01") config = normalizarConfig(null);
    else throw err;
  }
  cache.set(clave, { hasta: Date.now() + CACHE_MS, config });
  return config;
}

export async function guardarConfig(
  schemaRaw: string,
  empresaId: string,
  raw: unknown,
  usuarioNombre: string | null
): Promise<ConfigRrhh> {
  const config = normalizarConfig(raw);
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "rrhh_configuracion");
  await pool().query(
    `INSERT INTO ${t} (empresa_id, config, updated_at, updated_por) VALUES ($1::uuid, $2::jsonb, now(), $3)
     ON CONFLICT (empresa_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now(), updated_por = EXCLUDED.updated_por`,
    [empresaId, JSON.stringify(config), usuarioNombre]
  );
  cache.delete(`${schemaRaw}:${empresaId}`);
  return config;
}

export async function ultimaModificacion(
  schemaRaw: string,
  empresaId: string
): Promise<{ cuando: string; quien: string | null } | null> {
  const t = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "rrhh_configuracion");
  try {
    const r = await pool().query<{ cuando: string; quien: string | null }>(
      `SELECT to_char(updated_at AT TIME ZONE 'America/Asuncion', 'DD/MM/YYYY HH24:MI') AS cuando, updated_por AS quien
         FROM ${t} WHERE empresa_id = $1::uuid`,
      [empresaId]
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

/** ¿Este rol puede entrar a un módulo restringido, según la configuración? */
export function puedeEntrar(acceso: AccesoModulo, esAdmin: boolean): boolean {
  return acceso === "todos" || (acceso === "admin" && esAdmin);
}
