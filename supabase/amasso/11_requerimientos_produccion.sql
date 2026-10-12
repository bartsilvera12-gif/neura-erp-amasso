-- ============================================================================
-- 11_requerimientos_produccion.sql — base para los requerimientos de Amasso
-- (documento "Requerimientos del sistema de gestión", oct-2026).
--
-- SOLO AGREGA: columnas nuevas con valor por defecto y tablas nuevas. No borra
-- ni renombra nada, no cambia CHECKs existentes y no toca otros schemas. Se
-- puede correr más de una vez (IF NOT EXISTS en todo).
--
--  1. Clase de producto (6 tipos del documento) en `productos`.
--  2. Formulación: merma esperada y vida útil en `recetas`.
--  3. Órdenes de producción: estado, cantidad planificada/real, mermas, lote,
--     vencimiento y depósito en `producciones`.
--  4. Mermas y devoluciones con destino (desecho / galleta molida).
--  5. Conteo físico mensual por depósito.
--  6. Ajustes de inventario: motivo en `movimientos_inventario`.
--  7. RRHH: ausencia justificada y datos para liquidar sueldos.
--
-- Depósitos: no hace falta nada nuevo. El Punto de venta es la ubicación con
-- tipo `salon` (ya permitido por el CHECK); la Fábrica, una de tipo `deposito`.
-- ============================================================================

BEGIN;

-- 1. Clase de producto ───────────────────────────────────────────────────────
-- Se vende en Caja solo `terminado` y `reventa`. `es_vendible` se sigue
-- llenando igual (lo usa la caja), derivado de la clase.
ALTER TABLE amasso.productos
  ADD COLUMN IF NOT EXISTS clase_producto text NOT NULL DEFAULT 'reventa';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'productos_clase_producto_check' AND conrelid = 'amasso.productos'::regclass
  ) THEN
    ALTER TABLE amasso.productos ADD CONSTRAINT productos_clase_producto_check
      CHECK (clase_producto IN ('materia_prima', 'insumo', 'intermedio', 'terminado', 'reventa', 'merma'));
  END IF;
END $$;

-- Lo que hoy está marcado como no vendible pasa a materia prima; lo que tiene
-- formulación activa, a producto terminado. El resto queda en reventa.
UPDATE amasso.productos SET clase_producto = 'materia_prima'
 WHERE es_vendible = false AND clase_producto = 'reventa';
UPDATE amasso.productos p SET clase_producto = 'terminado'
 WHERE clase_producto = 'reventa'
   AND EXISTS (SELECT 1 FROM amasso.recetas r WHERE r.producto_id = p.id AND r.activa);

-- 2. Formulación ─────────────────────────────────────────────────────────────
ALTER TABLE amasso.recetas
  ADD COLUMN IF NOT EXISTS merma_esperada_pct numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vida_util_dias     integer;

-- 3. Órdenes de producción ───────────────────────────────────────────────────
-- Las producciones que ya existen quedan como `finalizada`: así se cargaron.
ALTER TABLE amasso.producciones
  ADD COLUMN IF NOT EXISTS estado               text NOT NULL DEFAULT 'finalizada',
  ADD COLUMN IF NOT EXISTS numero               text,
  ADD COLUMN IF NOT EXISTS cantidad_planificada numeric,
  ADD COLUMN IF NOT EXISTS merma_cantidad       numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lote                 text,
  ADD COLUMN IF NOT EXISTS fecha_vencimiento    date,
  ADD COLUMN IF NOT EXISTS ubicacion_id         uuid,
  ADD COLUMN IF NOT EXISTS iniciada_at          timestamptz,
  ADD COLUMN IF NOT EXISTS finalizada_at        timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'producciones_estado_check' AND conrelid = 'amasso.producciones'::regclass
  ) THEN
    ALTER TABLE amasso.producciones ADD CONSTRAINT producciones_estado_check
      CHECK (estado IN ('planificada', 'en_proceso', 'finalizada', 'cancelada'));
  END IF;
END $$;

-- 4. Mermas y devoluciones ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amasso.inventario_mermas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid NOT NULL,
  producto_id          uuid NOT NULL,
  producto_nombre      text NOT NULL,
  cantidad             numeric NOT NULL CHECK (cantidad > 0),
  ubicacion_id         uuid,
  origen               text NOT NULL DEFAULT 'merma'
                       CHECK (origen IN ('merma', 'devolucion', 'vencimiento', 'produccion')),
  destino              text NOT NULL CHECK (destino IN ('desecho', 'galleta_molida')),
  -- Si va a galleta molida: qué producto intermedio entra y cuánto.
  producto_destino_id  uuid,
  cantidad_destino     numeric,
  produccion_id        uuid,
  motivo               text,
  created_by           uuid,
  usuario_nombre       text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventario_mermas_empresa_idx ON amasso.inventario_mermas (empresa_id, created_at DESC);

-- 5. Conteo físico ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amasso.inventario_conteos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL,
  ubicacion_id  uuid NOT NULL,
  fecha         date NOT NULL DEFAULT current_date,
  estado        text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'cerrado')),
  observacion   text,
  created_by    uuid,
  cerrado_por   uuid,
  cerrado_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventario_conteos_empresa_idx ON amasso.inventario_conteos (empresa_id, fecha DESC);

CREATE TABLE IF NOT EXISTS amasso.inventario_conteo_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL,
  conteo_id         uuid NOT NULL REFERENCES amasso.inventario_conteos(id) ON DELETE CASCADE,
  producto_id       uuid NOT NULL,
  cantidad_sistema  numeric NOT NULL DEFAULT 0,
  cantidad_contada  numeric,
  motivo            text,
  CONSTRAINT inventario_conteo_items_uq UNIQUE (conteo_id, producto_id)
);

-- 6. Ajustes de inventario ───────────────────────────────────────────────────
-- Quién y cuándo ya se guardan (created_by, usuario_nombre, fecha). Faltaba el por qué.
ALTER TABLE amasso.movimientos_inventario
  ADD COLUMN IF NOT EXISTS motivo text;

-- 7. RRHH ────────────────────────────────────────────────────────────────────
ALTER TABLE amasso.asistencias
  ADD COLUMN IF NOT EXISTS justificada boolean;

ALTER TABLE amasso.empleados
  ADD COLUMN IF NOT EXISTS salario_base       numeric,
  ADD COLUMN IF NOT EXISTS tipo_remuneracion  text NOT NULL DEFAULT 'mensual',
  ADD COLUMN IF NOT EXISTS fecha_ingreso      date,
  ADD COLUMN IF NOT EXISTS aporta_ips         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS comision_pct       numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'empleados_tipo_remuneracion_check' AND conrelid = 'amasso.empleados'::regclass
  ) THEN
    ALTER TABLE amasso.empleados ADD CONSTRAINT empleados_tipo_remuneracion_check
      CHECK (tipo_remuneracion IN ('mensual', 'jornal'));
  END IF;
END $$;

-- Igual que el resto: RLS sin policies, solo el servidor.
ALTER TABLE amasso.inventario_mermas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.inventario_conteos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.inventario_conteo_items ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Las formulaciones se leen por PostgREST: sin esto no ve las columnas nuevas
-- hasta que se reinicie. Solo recarga su caché; no cambia la lista de schemas.
NOTIFY pgrst, 'reload schema';

-- Verificación
SELECT clase_producto, count(*) AS productos FROM amasso.productos GROUP BY 1 ORDER BY 1;
SELECT estado, count(*) AS producciones FROM amasso.producciones GROUP BY 1 ORDER BY 1;
