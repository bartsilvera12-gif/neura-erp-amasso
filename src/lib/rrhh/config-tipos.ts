/**
 * Tipos y valores por defecto de la configuración de asistencia. Sin
 * "server-only": los usa también la pantalla de configuración.
 *
 * Los valores por defecto son lo que el sistema hacía antes de que esto fuera
 * configurable, así que una empresa sin configuración guardada no cambia nada.
 */

/** nadie: oculto y bloqueado para todos · admin: solo administradores · todos: abierto. */
export type AccesoModulo = "nadie" | "admin" | "todos";

export type ConfigRrhh = {
  modulos: { gestion_clientes: AccesoModulo; bancos: AccesoModulo };
  horario: {
    /** fijo: cada empleado tiene su horario y se marca tarde · libre: turnos rotativos, sin tarde. */
    modo: "fijo" | "libre";
    tolerancia_min: number;
    /** Una jornada puede cruzar la medianoche. Si no, cada día empieza una nueva. */
    jornada_nocturna: boolean;
    /** Pasado esto sin salida, la jornada se da por abandonada (olvido de salida). */
    horas_max_jornada: number;
  };
  descansos: {
    /** null = sin límite. */
    breaks_max: number | null;
    break_max_min: number | null;
    almuerzo: boolean;
    almuerzo_max_min: number | null;
    descontar_break: boolean;
    descontar_almuerzo: boolean;
  };
  excepciones: {
    salida_con_pausa: "cerrar_y_avisar" | "bloquear";
    olvido_salida: "incompleta" | "cerrar_en_horario";
    /** Volver a entrar el mismo día después de marcar la salida. */
    reingreso: boolean;
  };
  autenticacion: { pin: "desactivado" | "opcional" | "obligatorio" };
  dispositivos: { boton_en_barra: boolean; terminal: boolean };
};

export const CONFIG_RRHH_DEFECTO: ConfigRrhh = {
  modulos: { gestion_clientes: "admin", bancos: "admin" },
  horario: { modo: "fijo", tolerancia_min: 10, jornada_nocturna: true, horas_max_jornada: 20 },
  descansos: {
    breaks_max: null,
    break_max_min: null,
    almuerzo: true,
    almuerzo_max_min: null,
    descontar_break: true,
    descontar_almuerzo: true,
  },
  excepciones: { salida_con_pausa: "cerrar_y_avisar", olvido_salida: "incompleta", reingreso: false },
  autenticacion: { pin: "opcional" },
  dispositivos: { boton_en_barra: true, terminal: false },
};

/** Lo que cualquier usuario necesita saber (menú y barra), sin el resto. */
export type ConfigPublica = Pick<ConfigRrhh, "modulos" | "dispositivos">;
