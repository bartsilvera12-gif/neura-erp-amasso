import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { AsistenciaError, guardarAsistencia, resumenDelMes, validarFecha } from "./asistencia-pg";

/**
 * Liquidación mensual y vacaciones (requerimientos de Amasso).
 *
 * Es un cálculo de referencia para la liquidación de sueldos y el IPS, no un
 * recibo de sueldo: el contador lo revisa antes de pagar. Reglas usadas
 * (Código del Trabajo e IPS, Paraguay):
 *
 *  - Mensual: se paga el salario; cada ausencia injustificada descuenta un día
 *    (salario / 30). Las justificadas no descuentan.
 *  - Jornal: jornal × días trabajados (presente o tarde) + días de vacaciones.
 *  - Horas extra: lo trabajado después de la hora de salida, con 50% de
 *    recargo (hora = salario / 30 / 8; en jornal, jornal / 8). No distingue
 *    nocturnas ni feriados (100%): eso se corrige a mano.
 *  - IPS: 9% a cargo del trabajador y 16,5% del empleador, sobre el bruto.
 *  - Comisión: % del empleado sobre el total (con IVA) de las ventas del mes
 *    en las que el cajero lo eligió como vendedor; las anuladas no cuentan.
 *    Es salario, así que suma al bruto y aporta IPS.
 *  - Aguinaldo: se provisiona 1/12 del bruto del mes.
 *  - Reposo: no lo paga el empleador (lo cubre IPS); se informa los días.
 *  - Vacaciones (art. 218): 12 días hábiles hasta 5 años de antigüedad, 18
 *    de 5 a 10, 30 desde 10. Se ganan al cumplir el primer año.
 */

export const IPS_OBRERO = 0.09;
export const IPS_PATRONAL = 0.165;
export const RECARGO_EXTRA = 0.5;

export type LiquidacionEmpleado = {
  empleado_id: string;
  nombre: string;
  documento: string | null;
  cargo: string | null;
  tipo_remuneracion: "mensual" | "jornal";
  salario_base: number | null;
  dias_trabajados: number;
  dias_vacaciones: number;
  dias_reposo: number;
  dias_permiso: number;
  ausencias_justificadas: number;
  ausencias_injustificadas: number;
  horas_trabajadas: number;
  horas_extra: number;
  monto_base: number;
  descuento_ausencias: number;
  monto_extras: number;
  ventas_mes: number;
  comision_pct: number | null;
  monto_comision: number;
  bruto: number;
  ips_obrero: number;
  ips_patronal: number;
  aguinaldo_provision: number;
  neto: number;
  aviso: string | null;
};

const red = (n: number) => Math.round(n);

export async function liquidacionDelMes(
  schemaRaw: string,
  empresaId: string,
  mes: string
): Promise<LiquidacionEmpleado[]> {
  const pool = getChatPostgresPool();
  if (!pool) throw new AsistenciaError("No hay conexión directa a Postgres.", 500);
  const resumen = await resumenDelMes(schemaRaw, empresaId, mes);
  const tE = quoteSchemaTable(assertAllowedChatDataSchema(schemaRaw), "empleados");
  const emp = await pool.query<{
    id: string; documento: string | null; salario_base: number | null; tipo_remuneracion: "mensual" | "jornal"; aporta_ips: boolean;
    comision_pct: number | null;
  }>(
    `SELECT id, documento, salario_base::float8 AS salario_base, tipo_remuneracion, aporta_ips,
            comision_pct::float8 AS comision_pct
       FROM ${tE} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  const porId = new Map(emp.rows.map((e) => [e.id, e]));

  // Ventas del mes por vendedor (script 13). Sin la columna, no hay comisiones.
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const ventasPorVendedor = new Map<string, number>();
  const hayCol = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'ventas' AND column_name = 'vendedor_empleado_id'`,
    [schema]
  );
  if (hayCol.rows.length > 0) {
    const tV = quoteSchemaTable(schema, "ventas");
    const v = await pool.query<{ vendedor: string; total: string }>(
      `SELECT vendedor_empleado_id AS vendedor, sum(total)::text AS total FROM ${tV}
        WHERE empresa_id = $1::uuid AND vendedor_empleado_id IS NOT NULL
          AND COALESCE(estado, '') NOT IN ('anulada', 'anulado')
          AND fecha >= ($2 || '-01')::date AND fecha < (($2 || '-01')::date + interval '1 month')
        GROUP BY 1`,
      [empresaId, mes]
    );
    for (const r of v.rows) ventasPorVendedor.set(r.vendedor, Number(r.total) || 0);
  }

  return resumen.map((r) => {
    const e = porId.get(r.empleado_id);
    const base = e?.salario_base ?? null;
    const tipo = e?.tipo_remuneracion ?? "mensual";
    const diasTrab = r.presente + r.tarde;
    const horasExtra = Math.round((r.minutos_extra / 60) * 100) / 100;
    let montoBase = 0;
    let descuento = 0;
    let valorHora = 0;
    if (base != null) {
      if (tipo === "jornal") {
        montoBase = base * (diasTrab + r.vacaciones);
        valorHora = base / 8;
      } else {
        montoBase = base;
        descuento = (base / 30) * r.ausente_injustificada;
        valorHora = base / 30 / 8;
      }
    }
    const extras = horasExtra * valorHora * (1 + RECARGO_EXTRA);
    const ventasMes = ventasPorVendedor.get(r.empleado_id) ?? 0;
    const pct = e?.comision_pct ?? null;
    const comision = pct ? (ventasMes * pct) / 100 : 0;
    const bruto = Math.max(0, montoBase - descuento + extras + comision);
    const ipsObrero = e?.aporta_ips === false ? 0 : bruto * IPS_OBRERO;
    return {
      empleado_id: r.empleado_id,
      nombre: r.nombre,
      documento: e?.documento ?? null,
      cargo: r.cargo,
      tipo_remuneracion: tipo,
      salario_base: base,
      dias_trabajados: diasTrab,
      dias_vacaciones: r.vacaciones,
      dias_reposo: r.reposo,
      dias_permiso: r.permiso,
      ausencias_justificadas: r.ausente_justificada,
      ausencias_injustificadas: r.ausente_injustificada,
      horas_trabajadas: Math.round((r.minutos / 60) * 100) / 100,
      horas_extra: horasExtra,
      monto_base: red(montoBase),
      descuento_ausencias: red(descuento),
      monto_extras: red(extras),
      ventas_mes: red(ventasMes),
      comision_pct: pct,
      monto_comision: red(comision),
      bruto: red(bruto),
      ips_obrero: red(ipsObrero),
      ips_patronal: e?.aporta_ips === false ? 0 : red(bruto * IPS_PATRONAL),
      aguinaldo_provision: red(bruto / 12),
      neto: red(bruto - ipsObrero),
      aviso: base == null ? "Sin salario cargado" : r.sin_salida > 0 ? `${r.sin_salida} día(s) sin salida: horas incompletas` : null,
    };
  });
}

/** Liquidación en CSV (Excel la abre directo; separador `;` y coma decimal). */
export function liquidacionCsv(mes: string, filas: LiquidacionEmpleado[]): string {
  const cols: [string, (f: LiquidacionEmpleado) => string | number | null][] = [
    ["Empleado", (f) => f.nombre],
    ["Cédula", (f) => f.documento],
    ["Cargo", (f) => f.cargo],
    ["Remuneración", (f) => f.tipo_remuneracion],
    ["Salario / jornal", (f) => f.salario_base],
    ["Días trabajados", (f) => f.dias_trabajados],
    ["Vacaciones", (f) => f.dias_vacaciones],
    ["Reposo", (f) => f.dias_reposo],
    ["Permiso", (f) => f.dias_permiso],
    ["Ausencias justificadas", (f) => f.ausencias_justificadas],
    ["Ausencias injustificadas", (f) => f.ausencias_injustificadas],
    ["Horas trabajadas", (f) => f.horas_trabajadas],
    ["Horas extra", (f) => f.horas_extra],
    ["Monto base", (f) => f.monto_base],
    ["Descuento ausencias", (f) => f.descuento_ausencias],
    ["Horas extra (Gs.)", (f) => f.monto_extras],
    ["Ventas del mes", (f) => f.ventas_mes],
    ["Comisión %", (f) => f.comision_pct],
    ["Comisión (Gs.)", (f) => f.monto_comision],
    ["Bruto", (f) => f.bruto],
    ["IPS trabajador 9%", (f) => f.ips_obrero],
    ["IPS empleador 16,5%", (f) => f.ips_patronal],
    ["Aguinaldo (provisión)", (f) => f.aguinaldo_provision],
    ["Neto a cobrar", (f) => f.neto],
    ["Aviso", (f) => f.aviso],
  ];
  const celda = (v: string | number | null) => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(v).replace(".", ",") : v;
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [
    `Liquidación ${mes}`,
    cols.map(([h]) => h).join(";"),
    ...filas.map((f) => cols.map(([, g]) => celda(g(f))).join(";")),
  ];
  // BOM para que Excel respete los acentos.
  return "﻿" + lineas.join("\r\n");
}

export type SaldoVacaciones = {
  empleado_id: string;
  nombre: string;
  fecha_ingreso: string | null;
  antiguedad_anios: number | null;
  dias_que_corresponden: number | null;
  dias_tomados_anio: number;
  dias_reposo_anio: number;
};

function diasPorAntiguedad(anios: number): number {
  if (anios < 1) return 0;
  if (anios <= 5) return 12;
  if (anios <= 10) return 18;
  return 30;
}

export async function saldoVacaciones(schemaRaw: string, empresaId: string, anio: number): Promise<SaldoVacaciones[]> {
  const pool = getChatPostgresPool();
  if (!pool) throw new AsistenciaError("No hay conexión directa a Postgres.", 500);
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tE = quoteSchemaTable(schema, "empleados");
  const tA = quoteSchemaTable(schema, "asistencias");
  const { rows } = await pool.query<{
    id: string; nombre: string; fecha_ingreso: string | null; vac: string; rep: string;
  }>(
    `SELECT e.id, e.nombre, e.fecha_ingreso::text AS fecha_ingreso,
            count(a.id) FILTER (WHERE a.estado = 'vacaciones')::text AS vac,
            count(a.id) FILTER (WHERE a.estado = 'reposo')::text AS rep
       FROM ${tE} e
       LEFT JOIN ${tA} a ON a.empleado_id = e.id AND a.empresa_id = e.empresa_id
        AND a.fecha >= make_date($2, 1, 1) AND a.fecha < make_date($2 + 1, 1, 1)
      WHERE e.empresa_id = $1::uuid AND e.activo
      GROUP BY e.id ORDER BY e.nombre`,
    [empresaId, anio]
  );
  const hoy = new Date();
  return rows.map((r) => {
    const anios = r.fecha_ingreso
      ? Math.floor((hoy.getTime() - Date.parse(`${r.fecha_ingreso}T12:00:00Z`)) / (365.25 * 864e5))
      : null;
    return {
      empleado_id: r.id,
      nombre: r.nombre,
      fecha_ingreso: r.fecha_ingreso,
      antiguedad_anios: anios,
      dias_que_corresponden: anios == null ? null : diasPorAntiguedad(anios),
      dias_tomados_anio: Number(r.vac),
      dias_reposo_anio: Number(r.rep),
    };
  });
}

/**
 * Carga un período de vacaciones, reposo o permiso (o una ausencia de varios
 * días) en un solo paso: un registro por día, sin horas.
 */
export async function registrarRango(
  schemaRaw: string,
  empresaId: string,
  d: { empleado_id: unknown; desde: unknown; hasta: unknown; estado: unknown; justificada?: unknown; observacion?: unknown },
  registradoPor: string | null
): Promise<number> {
  const desde = validarFecha(d.desde);
  const hasta = validarFecha(d.hasta);
  if (hasta < desde) throw new AsistenciaError("La fecha final es anterior a la inicial.");
  const estado = String(d.estado ?? "");
  if (!["vacaciones", "reposo", "permiso", "ausente"].includes(estado)) {
    throw new AsistenciaError("Para un período se usa vacaciones, reposo, permiso o ausente.");
  }
  const dias: string[] = [];
  for (let t = Date.parse(`${desde}T12:00:00Z`); t <= Date.parse(`${hasta}T12:00:00Z`); t += 864e5) {
    dias.push(new Date(t).toISOString().slice(0, 10));
    if (dias.length > 62) throw new AsistenciaError("El período no puede pasar de 2 meses.");
  }
  for (const fecha of dias) {
    await guardarAsistencia(
      schemaRaw,
      empresaId,
      {
        empleado_id: d.empleado_id,
        fecha,
        estado,
        observacion: d.observacion ?? null,
        ...(estado === "ausente" ? { justificada: d.justificada === true } : {}),
      },
      registradoPor
    );
  }
  return dias.length;
}
