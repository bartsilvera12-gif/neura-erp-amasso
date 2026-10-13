-- ============================================================================
-- 15_rrhh_configuracion.sql — configuración de asistencia (RRHH › Configuración)
--
-- Las decisiones de la especificación (punto 6: módulos ocultos, horario,
-- descansos, excepciones, PIN y dispositivos) pasan a ser configurables por el
-- administrador en vez de estar fijas en el código.
--
-- SOLO AGREGA, y solo en el schema amasso. Se puede correr más de una vez.
--
--  1. rrhh_configuracion: una fila por empresa con la configuración (jsonb).
--     Sin fila, el sistema usa los valores de siempre.
--  2. asistencias.minutos_fuera: tiempo entre una salida y un reingreso el
--     mismo día, para no contarlo como trabajado.
--
-- Reversión: DROP TABLE amasso.rrhh_configuracion; ALTER TABLE
-- amasso.asistencias DROP COLUMN minutos_fuera. Nada existente depende de ellos.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS amasso.rrhh_configuracion (
  empresa_id        uuid PRIMARY KEY,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_por       text
);

ALTER TABLE amasso.asistencias
  ADD COLUMN IF NOT EXISTS minutos_fuera integer NOT NULL DEFAULT 0;

-- Igual que el resto: RLS sin policies, solo el servidor.
ALTER TABLE amasso.rrhh_configuracion ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Que PostgREST vea lo nuevo sin esperar (solo refresca su caché).
NOTIFY pgrst, 'reload schema';

-- Verificación: la tabla con rls = true y la columna nueva.
SELECT 'rrhh_configuracion' AS objeto, c.relrowsecurity::text AS rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'amasso' AND c.relname = 'rrhh_configuracion'
UNION ALL
SELECT 'asistencias.minutos_fuera', 'columna'
  FROM information_schema.columns
 WHERE table_schema = 'amasso' AND table_name = 'asistencias' AND column_name = 'minutos_fuera';
