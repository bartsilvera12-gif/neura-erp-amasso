-- ============================================================================
-- 17_limpieza_datos_prueba.sql — deja Amasso limpio para la entrega
--
-- BORRA (todo lo cargado en las pruebas):
--   ventas, cobros, facturas, pagos, asientos, cajas, compras, órdenes,
--   recepciones, gastos, movimientos y stock, conteos, mermas, producción,
--   recetas, repartos y el camión de prueba, agenda, historial y tipificaciones
--   de clientes, asistencia; productos, clientes, proveedores y empleados.
--   Usuarios: vendedor@amasso.com, juan@gmail.com y ana@gmail.com (también su
--   cuenta de acceso; ningún otro ERP las usa, y el script lo vuelve a revisar).
--
-- DEJA: la empresa, admin@amasso.com y administrador@amasso.com, módulos,
--   plan de cuentas y configuración contable, período contable, bancos,
--   depósitos (salvo el del camión), categorías de productos y de proveedores,
--   configuración de facturación, de RRHH y de comisiones.
--
-- Numeraciones: OC, RC, gastos, facturas, asientos y códigos de producto
--   vuelven a empezar en 1. Ventas y cajas se numeran solas desde lo que haya.
--
-- Solo toca el schema amasso y, para esos tres usuarios, auth.users.
-- Todo en una transacción: si algo falla, no se borra nada.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _e ON COMMIT DROP AS SELECT '26f2bd0a-3394-4256-a908-bf8784368fd5'::uuid AS id;
CREATE TEMP TABLE _usuarios_fuera ON COMMIT DROP AS
  SELECT id, auth_user_id FROM amasso.usuarios
   WHERE empresa_id = (SELECT id FROM _e)
     AND lower(email) IN ('vendedor@amasso.com', 'juan@gmail.com', 'ana@gmail.com');

-- Agenda, clientes (historial / tipificaciones)
DELETE FROM amasso.agenda_cita_responsables WHERE cita_id IN (SELECT id FROM amasso.agenda_citas WHERE empresa_id = (SELECT id FROM _e));
DELETE FROM amasso.agenda_citas            WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.tipificaciones          WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.cliente_historial       WHERE empresa_id = (SELECT id FROM _e);

-- Asistencia
DELETE FROM amasso.asistencia_correcciones WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.asistencia_eventos      WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.asistencia_intentos     WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.asistencias             WHERE empresa_id = (SELECT id FROM _e);

-- Caja, cobros, facturas, contabilidad
DELETE FROM amasso.caja_movimientos        WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.cajas                   WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.pagos                   WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.cobros_pendientes       WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.factura_items           WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.facturas                WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.asientos_contables_detalles WHERE asiento_id IN (SELECT id FROM amasso.asientos_contables WHERE empresa_id = (SELECT id FROM _e));
DELETE FROM amasso.asientos_contables      WHERE empresa_id = (SELECT id FROM _e);

-- Ventas e inventario
DELETE FROM amasso.ventas_pagos_detalle    WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.movimientos_inventario  WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.ventas_items            WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.ventas                  WHERE empresa_id = (SELECT id FROM _e);

-- Compras, recepciones, órdenes, gastos
DELETE FROM amasso.compra_items            WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.compras                 WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.recepcion_items         WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.recepciones             WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.orden_compra_items      WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.ordenes_compra          WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.gasto_items             WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.gastos                  WHERE empresa_id = (SELECT id FROM _e);

-- Conteos, mermas, producción, repartos
DELETE FROM amasso.inventario_conteo_items WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.inventario_conteos      WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.inventario_mermas       WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.produccion_items        WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.producciones            WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.reparto_stock           WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.repartos                WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.camiones                WHERE empresa_id = (SELECT id FROM _e);

-- Catálogo
DELETE FROM amasso.inventario_stock_ubicacion WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.receta_items            WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.recetas                 WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.producto_categorias     WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.productos               WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.proveedor_categoria_rel WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.proveedores             WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.clientes                WHERE empresa_id = (SELECT id FROM _e);
DELETE FROM amasso.empleados               WHERE empresa_id = (SELECT id FROM _e);

-- El depósito del camión de prueba (los demás quedan)
DELETE FROM amasso.inventario_ubicaciones  WHERE empresa_id = (SELECT id FROM _e) AND tipo = 'camion';

-- Usuarios de prueba
DELETE FROM amasso.chat_usuario_omnicanal  WHERE usuario_id IN (SELECT id FROM _usuarios_fuera);
DELETE FROM amasso.usuario_modulos         WHERE usuario_id IN (SELECT id FROM _usuarios_fuera);
DELETE FROM amasso.usuario_permisos        WHERE usuario_id IN (SELECT id FROM _usuarios_fuera);
DELETE FROM amasso.usuarios                WHERE id IN (SELECT id FROM _usuarios_fuera);

-- Su cuenta de acceso, solo si ningún otro schema la usa.
DO $$
DECLARE
  s text;
  usada boolean;
  u record;
BEGIN
  FOR u IN SELECT auth_user_id FROM _usuarios_fuera WHERE auth_user_id IS NOT NULL LOOP
    usada := false;
    FOR s IN
      SELECT table_schema FROM information_schema.columns
       WHERE table_name = 'usuarios' AND column_name = 'auth_user_id' AND table_schema <> 'amasso'
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.usuarios WHERE auth_user_id::text = $1)', s) INTO usada USING u.auth_user_id::text;
      EXIT WHEN usada;
    END LOOP;
    IF usada THEN
      RAISE NOTICE 'Cuenta % la usa el schema %: no se borra de Auth.', u.auth_user_id, s;
    ELSE
      DELETE FROM auth.users WHERE id = u.auth_user_id;
    END IF;
  END LOOP;
END $$;

-- Numeraciones desde 1
UPDATE amasso.orden_correlativos      SET ultimo_numero = 0, updated_at = now() WHERE empresa_id = (SELECT id FROM _e);
UPDATE amasso.recepcion_correlativos  SET ultimo_numero = 0, updated_at = now() WHERE empresa_id = (SELECT id FROM _e);
UPDATE amasso.gasto_correlativos      SET ultimo_numero = 0, updated_at = now() WHERE empresa_id = (SELECT id FROM _e);
UPDATE amasso.factura_correlativos    SET ultimo_numero = 0, updated_at = now() WHERE empresa_id = (SELECT id FROM _e);
UPDATE amasso.asiento_correlativos    SET ultimo_numero = 0, updated_at = now() WHERE empresa_id = (SELECT id FROM _e);
UPDATE amasso.productos_codigo_secuencia SET last_value = 0, updated_at = now() WHERE empresa_id = (SELECT id FROM _e);

COMMIT;

-- Verificación: todo en 0 menos lo que se deja (usuarios = 2, depósitos = 2).
SELECT 'ventas' AS tabla, count(*) FROM amasso.ventas
UNION ALL SELECT 'compras', count(*) FROM amasso.compras
UNION ALL SELECT 'movimientos_inventario', count(*) FROM amasso.movimientos_inventario
UNION ALL SELECT 'asientos_contables', count(*) FROM amasso.asientos_contables
UNION ALL SELECT 'facturas', count(*) FROM amasso.facturas
UNION ALL SELECT 'cajas', count(*) FROM amasso.cajas
UNION ALL SELECT 'productos', count(*) FROM amasso.productos
UNION ALL SELECT 'clientes', count(*) FROM amasso.clientes
UNION ALL SELECT 'proveedores', count(*) FROM amasso.proveedores
UNION ALL SELECT 'empleados', count(*) FROM amasso.empleados
UNION ALL SELECT 'usuarios (quedan 2)', count(*) FROM amasso.usuarios
UNION ALL SELECT 'depósitos (quedan 2)', count(*) FROM amasso.inventario_ubicaciones
UNION ALL SELECT 'plan de cuentas (se deja)', count(*) FROM amasso.plan_cuentas
UNION ALL SELECT 'bancos (se dejan)', count(*) FROM amasso.bancos;
