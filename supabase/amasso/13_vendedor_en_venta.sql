-- ============================================================================
-- 13_vendedor_en_venta.sql — vendedor de cada venta (para la comisión).
--
-- Los vendedores de Amasso no tienen cuenta en el sistema: son empleados de
-- RRHH. El cajero elige el vendedor en la Caja y queda en esta columna; la
-- liquidación le calcula la comisión con el % cargado en su ficha.
--
-- Solo agrega una columna (vacía) y un índice en amasso.ventas. No toca nada
-- más ni otros schemas. Se puede correr más de una vez. El ERP funciona igual
-- sin esto; con esto empieza a guardar el vendedor.
-- ============================================================================

ALTER TABLE amasso.ventas
  ADD COLUMN IF NOT EXISTS vendedor_empleado_id uuid REFERENCES amasso.empleados(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ventas_vendedor_empleado_idx
  ON amasso.ventas (empresa_id, vendedor_empleado_id, fecha)
  WHERE vendedor_empleado_id IS NOT NULL;

-- Verificación: tiene que devolver una fila.
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'amasso' AND table_name = 'ventas' AND column_name = 'vendedor_empleado_id';
