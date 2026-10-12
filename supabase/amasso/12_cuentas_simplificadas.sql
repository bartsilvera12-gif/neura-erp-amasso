-- ============================================================================
-- 12_cuentas_simplificadas.sql — las 12 cuentas del documento de Amasso.
--
-- Las 12 cuentas son las de USO: las que se eligen al cargar una compra o un
-- gasto. Las cuentas que el sistema necesita para la partida doble (Caja,
-- Bancos, IVA, Proveedores, Clientes, Costo de mercaderías vendidas) siguen
-- existiendo: sin ellas no se puede asentar nada.
--
-- No borra nada. Renombra las que ya existían con otro nombre y agrega las
-- que faltan. Los asientos ya hechos no cambian: apuntan al id de la cuenta,
-- no al nombre. Se puede correr más de una vez.
--
--   N.º  Cuenta del documento          Cuenta del plan
--   1    Ventas                        4.1  VENTAS (con 10% / 5% / exentas, por el IVA)
--   2    Materias primas               1.1.07 MATERIAS PRIMAS            (nueva)
--   3    Insumos y empaques            1.1.08 INSUMOS Y EMPAQUES         (nueva)
--   4    Mercadería de reventa         1.1.06 MERCADERIA DE REVENTA      (antes MERCADERIAS)
--   5    Sueldos y cargas sociales     5.1.04 SUELDOS Y CARGAS SOCIALES  (antes SUELDOS Y JORNALES)
--   6    Alquiler                      5.1.05 ALQUILER                   (nueva)
--   7    Servicios                     5.1.06 SERVICIOS                  (nueva)
--   8    Reparto                       5.1.03 REPARTO                    (antes COMBUSTIBLE Y MANTENIMIENTO)
--   9    Mantenimiento y limpieza      5.1.07 MANTENIMIENTO Y LIMPIEZA   (nueva)
--   10   Impuestos                     5.1.08 IMPUESTOS                  (nueva)
--   11   Otros gastos                  5.1.02 OTROS GASTOS               (antes GASTOS OPERATIVOS)
--   12   Equipos y mejoras             1.2.01 EQUIPOS Y MEJORAS          (nueva, activo no corriente)
-- ============================================================================

DO $$
DECLARE
  v_empresa uuid;
  v_fila    text[];
  v_nuevas  text[][] := ARRAY[
    -- cuenta | denominación | nivel | naturaleza | asentable
    ARRAY['1.1.07', 'MATERIAS PRIMAS',          '3', 'D', 'true'],
    ARRAY['1.1.08', 'INSUMOS Y EMPAQUES',       '3', 'D', 'true'],
    ARRAY['1.2',    'ACTIVO NO CORRIENTE',      '2', 'D', 'false'],
    ARRAY['1.2.01', 'EQUIPOS Y MEJORAS',        '3', 'D', 'true'],
    ARRAY['5.1.05', 'ALQUILER',                 '3', 'D', 'true'],
    ARRAY['5.1.06', 'SERVICIOS',                '3', 'D', 'true'],
    ARRAY['5.1.07', 'MANTENIMIENTO Y LIMPIEZA', '3', 'D', 'true'],
    ARRAY['5.1.08', 'IMPUESTOS',                '3', 'D', 'true']
  ];
BEGIN
  SELECT id INTO v_empresa FROM amasso.empresas ORDER BY created_at LIMIT 1;
  IF v_empresa IS NULL THEN RAISE EXCEPTION 'no hay empresa en amasso'; END IF;

  -- Renombres (solo si todavía tienen el nombre viejo: no pisa un cambio a mano).
  UPDATE amasso.plan_cuentas SET denominacion = 'MERCADERIA DE REVENTA'
   WHERE empresa_id = v_empresa AND cuenta = '1.1.06' AND denominacion = 'MERCADERIAS';
  UPDATE amasso.plan_cuentas SET denominacion = 'SUELDOS Y CARGAS SOCIALES'
   WHERE empresa_id = v_empresa AND cuenta = '5.1.04' AND denominacion = 'SUELDOS Y JORNALES';
  UPDATE amasso.plan_cuentas SET denominacion = 'REPARTO'
   WHERE empresa_id = v_empresa AND cuenta = '5.1.03' AND denominacion = 'COMBUSTIBLE Y MANTENIMIENTO';
  UPDATE amasso.plan_cuentas SET denominacion = 'OTROS GASTOS'
   WHERE empresa_id = v_empresa AND cuenta = '5.1.02' AND denominacion = 'GASTOS OPERATIVOS';

  FOREACH v_fila SLICE 1 IN ARRAY v_nuevas LOOP
    INSERT INTO amasso.plan_cuentas (empresa_id, cuenta, denominacion, nivel, naturaleza, asentable)
    VALUES (v_empresa, v_fila[1], v_fila[2], v_fila[3]::int, v_fila[4], v_fila[5]::boolean)
    ON CONFLICT (empresa_id, cuenta) DO NOTHING;
  END LOOP;

  -- Padre de cada cuenta nueva: la cuenta con el código sin el último tramo.
  UPDATE amasso.plan_cuentas h
     SET cuenta_padre_id = p.id
    FROM amasso.plan_cuentas p
   WHERE h.empresa_id = v_empresa AND p.empresa_id = v_empresa
     AND h.cuenta_padre_id IS NULL
     AND position('.' in h.cuenta) > 0
     AND p.cuenta = regexp_replace(h.cuenta, '\.[^.]+$', '');
END $$;

-- Verificación: el plan completo.
SELECT cuenta, denominacion, asentable FROM amasso.plan_cuentas ORDER BY cuenta;
