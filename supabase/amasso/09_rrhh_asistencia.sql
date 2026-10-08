-- ============================================================================
-- 09_rrhh_asistencia.sql — Empleados y asistencia (schema `amasso`)
--
-- Crea dos tablas nuevas. No modifica ni borra nada existente y no toca otros
-- schemas. Se puede correr más de una vez: todo es IF NOT EXISTS.
--
-- Por qué una tabla de empleados aparte de `usuarios`: en una panadería la
-- mayoría del personal (panaderos, ayudantes) no entra al ERP. `usuarios` son
-- cuentas con login; `empleados` es la nómina de gente a la que se le toma
-- asistencia. Si un empleado además usa el ERP, se puede vincular con
-- `usuario_id`, pero no hace falta.
--
-- Seguridad: igual que `camiones` o `repartos`, RLS activado y SIN policies.
-- Nadie entra por la API pública (anon/authenticated); solo el servidor del
-- ERP, que usa la conexión directa y valida la empresa en cada consulta.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS amasso.empleados (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL,
  nombre           text NOT NULL CHECK (btrim(nombre) <> ''),
  documento        text,
  cargo            text,
  telefono         text,
  -- Hora a la que tiene que entrar. Con esto la asistencia marca "tarde" sola
  -- cuando la entrada llega después de esta hora más la tolerancia.
  horario_entrada  time,
  horario_salida   time,
  usuario_id       uuid REFERENCES amasso.usuarios(id) ON DELETE SET NULL,
  activo           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS empleados_empresa_idx ON amasso.empleados (empresa_id, activo, nombre);
CREATE UNIQUE INDEX IF NOT EXISTS empleados_documento_uq
  ON amasso.empleados (empresa_id, documento)
  WHERE documento IS NOT NULL AND btrim(documento) <> '';

CREATE TABLE IF NOT EXISTS amasso.asistencias (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL,
  empleado_id      uuid NOT NULL REFERENCES amasso.empleados(id) ON DELETE CASCADE,
  fecha            date NOT NULL,
  estado           text NOT NULL DEFAULT 'presente'
                   CHECK (estado IN ('presente', 'tarde', 'ausente', 'permiso', 'vacaciones', 'reposo')),
  hora_entrada     timestamptz,
  hora_salida      timestamptz,
  observacion      text,
  registrado_por   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Un registro por empleado por día: marcar dos veces actualiza, no duplica.
  CONSTRAINT asistencias_un_registro_por_dia UNIQUE (empresa_id, empleado_id, fecha),
  CONSTRAINT asistencias_salida_despues_de_entrada
    CHECK (hora_salida IS NULL OR hora_entrada IS NULL OR hora_salida >= hora_entrada)
);

CREATE INDEX IF NOT EXISTS asistencias_empresa_fecha_idx ON amasso.asistencias (empresa_id, fecha);

ALTER TABLE amasso.empleados   ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.asistencias ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Verificación: tiene que devolver las dos tablas con rls = true.
SELECT c.relname AS tabla, c.relrowsecurity AS rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'amasso' AND c.relname IN ('empleados', 'asistencias')
 ORDER BY 1;
