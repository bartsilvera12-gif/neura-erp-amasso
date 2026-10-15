-- ============================================================================
-- 16_stock_sin_deposito.sql — stock que figuraba en el total pero en ningún depósito
--
-- Al dar de alta un producto con "Stock actual" y sin "Ubicación principal",
-- el stock sumaba a productos.stock_actual pero no entraba a ningún depósito.
-- Caja, mermas y transferencias miran el depósito, así que veían 0.
--
-- Esto pone la diferencia (total − lo que hay en los depósitos) en el depósito
-- que corresponde por clase, igual que hace ahora el alta:
--   · Producto terminado y Reventa  → Punto de venta (tipo 'salon')
--   · Materia prima, Insumo, Intermedio, Merma → Fábrica / depósito (tipo 'deposito')
--
-- Solo toca el schema amasso. No cambia el total de ningún producto. Si se
-- corre otra vez, no hace nada (la diferencia ya es 0).
-- ============================================================================

BEGIN;

WITH ubic AS (
  SELECT DISTINCT ON (empresa_id, tipo) empresa_id, tipo, id
    FROM amasso.inventario_ubicaciones
   WHERE tipo IN ('salon', 'deposito') AND COALESCE(activo, true)
   ORDER BY empresa_id, tipo, created_at
),
dif AS (
  SELECT p.empresa_id, p.id AS producto_id,
         p.stock_actual - COALESCE((SELECT sum(s.stock_actual) FROM amasso.inventario_stock_ubicacion s
                                     WHERE s.producto_id = p.id AND s.empresa_id = p.empresa_id), 0) AS falta,
         CASE WHEN p.clase_producto IN ('terminado', 'reventa') THEN 'salon' ELSE 'deposito' END AS tipo
    FROM amasso.productos p
),
destino AS (
  SELECT d.empresa_id, d.producto_id, d.falta,
         COALESCE(u.id, (SELECT id FROM ubic u2 WHERE u2.empresa_id = d.empresa_id LIMIT 1)) AS ubicacion_id
    FROM dif d
    LEFT JOIN ubic u ON u.empresa_id = d.empresa_id AND u.tipo = d.tipo
   WHERE d.falta > 0.0001
),
actualizadas AS (
  UPDATE amasso.inventario_stock_ubicacion s
     SET stock_actual = s.stock_actual + d.falta, updated_at = now()
    FROM destino d
   WHERE s.producto_id = d.producto_id AND s.ubicacion_id = d.ubicacion_id AND s.empresa_id = d.empresa_id
  RETURNING s.producto_id, s.ubicacion_id
)
INSERT INTO amasso.inventario_stock_ubicacion (empresa_id, producto_id, ubicacion_id, stock_actual)
SELECT d.empresa_id, d.producto_id, d.ubicacion_id, d.falta
  FROM destino d
 WHERE d.ubicacion_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM actualizadas a WHERE a.producto_id = d.producto_id AND a.ubicacion_id = d.ubicacion_id);

COMMIT;

-- Verificación: tiene que dar 0 filas (ningún producto con stock fuera de los depósitos).
SELECT p.nombre, p.stock_actual,
       COALESCE((SELECT sum(s.stock_actual) FROM amasso.inventario_stock_ubicacion s WHERE s.producto_id = p.id), 0) AS en_depositos
  FROM amasso.productos p
 WHERE abs(p.stock_actual - COALESCE((SELECT sum(s.stock_actual) FROM amasso.inventario_stock_ubicacion s WHERE s.producto_id = p.id), 0)) > 0.0001
 ORDER BY 1;
