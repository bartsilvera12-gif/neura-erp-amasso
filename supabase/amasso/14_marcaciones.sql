-- ============================================================================
-- 14_marcaciones.sql — marcación de asistencia por el propio empleado
-- (especificación funcional de Amasso, 12-oct-2026: RF-01 a RF-04).
--
-- SOLO AGREGA, y solo en el schema amasso: columnas nuevas con valor por
-- defecto y tablas nuevas. No borra ni cambia nada existente. Se puede correr
-- más de una vez.
--
--  1. Empleado: código único y PIN opcional (guardado como hash, nunca en claro).
--  2. asistencia_eventos: cada marcación (entrada, break, almuerzo, salida) con
--     hora del servidor, quién estaba logueado y desde qué dispositivo.
--  3. asistencia_correcciones: toda corrección de un administrador, con motivo,
--     quién, cuándo y el valor anterior y el nuevo.
--  4. asistencia_intentos: para limitar los intentos fallidos de identificación.
--  5. asistencias (resumen diario): minutos de break y almuerzo, y si la jornada
--     quedó incompleta (entrada sin salida).
--
-- Reversión: estas tablas y columnas son nuevas; para volver atrás alcanza con
-- DROP TABLE de las tres tablas y DROP COLUMN de las columnas agregadas. Nada
-- de lo existente depende de ellas.
-- ============================================================================

BEGIN;

-- 1. Empleado ────────────────────────────────────────────────────────────────
ALTER TABLE amasso.empleados
  ADD COLUMN IF NOT EXISTS codigo   text,
  ADD COLUMN IF NOT EXISTS pin_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS empleados_codigo_uq
  ON amasso.empleados (empresa_id, lower(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';

-- 2. Marcaciones ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amasso.asistencia_eventos (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid NOT NULL,
  empleado_id            uuid NOT NULL REFERENCES amasso.empleados(id) ON DELETE CASCADE,
  -- Día de la jornada (el de la entrada; una jornada que cruza medianoche sigue
  -- siendo del día en que empezó).
  jornada                date NOT NULL,
  tipo                   text NOT NULL CHECK (tipo IN
                           ('entrada', 'inicio_break', 'fin_break', 'inicio_almuerzo', 'fin_almuerzo', 'salida')),
  momento                timestamptz NOT NULL DEFAULT now(),
  origen                 text NOT NULL DEFAULT 'autoservicio'
                           CHECK (origen IN ('autoservicio', 'admin', 'reloj', 'importacion')),
  -- Usuario del ERP cuya sesión estaba abierta (no es quien marcó).
  sesion_usuario_id      uuid,
  sesion_usuario_nombre  text,
  dispositivo            text,
  anulado                boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asistencia_eventos_emp_idx ON amasso.asistencia_eventos (empresa_id, empleado_id, momento DESC);
CREATE INDEX IF NOT EXISTS asistencia_eventos_jornada_idx ON amasso.asistencia_eventos (empresa_id, jornada);

-- 3. Correcciones ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amasso.asistencia_correcciones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL,
  empleado_id     uuid NOT NULL REFERENCES amasso.empleados(id) ON DELETE CASCADE,
  evento_id       uuid REFERENCES amasso.asistencia_eventos(id) ON DELETE SET NULL,
  jornada         date NOT NULL,
  accion          text NOT NULL CHECK (accion IN ('agregar', 'modificar', 'anular')),
  antes           jsonb,
  despues         jsonb,
  motivo          text NOT NULL CHECK (btrim(motivo) <> ''),
  usuario_id      uuid,
  usuario_nombre  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asistencia_correcciones_idx ON amasso.asistencia_correcciones (empresa_id, empleado_id, jornada);

-- 4. Intentos de identificación ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amasso.asistencia_intentos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL,
  clave       text NOT NULL,
  exitoso     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asistencia_intentos_idx ON amasso.asistencia_intentos (empresa_id, clave, created_at DESC);

-- 5. Resumen diario ──────────────────────────────────────────────────────────
ALTER TABLE amasso.asistencias
  ADD COLUMN IF NOT EXISTS minutos_break    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minutos_almuerzo integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incompleta       boolean NOT NULL DEFAULT false;

-- Igual que el resto: RLS sin policies, solo el servidor.
ALTER TABLE amasso.asistencia_eventos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.asistencia_correcciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.asistencia_intentos     ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Verificación: tres tablas, las tres con rls = true.
SELECT c.relname AS tabla, c.relrowsecurity AS rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'amasso' AND c.relname IN ('asistencia_eventos', 'asistencia_correcciones', 'asistencia_intentos')
 ORDER BY 1;
