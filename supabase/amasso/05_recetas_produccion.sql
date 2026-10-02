-- =============================================================================
-- 05 · RECETAS Y PRODUCCIÓN — habilitar el origen 'produccion' en el kardex
-- =============================================================================
-- Las tablas del recetario (`recetas`, `receta_items`, `producciones`,
-- `produccion_items`) y la columna `movimientos_inventario.produccion_id` YA
-- vienen en el clon: estaban en el schema origen. Este script no crea nada de
-- eso. Lo único que falta es un permiso en un CHECK.
--
-- EL PROBLEMA
--   El CHECK de `movimientos_inventario.origen` que heredamos enumera los
--   valores del ciclo de distribución —compra, recepcion, venta, anulacion,
--   transferencia, rendicion_reparto, inventario_inicial, carga_proveedor— y
--   NO incluye `produccion`. Al confirmar la primera fabricación, el kardex
--   rechaza el movimiento:
--
--     new row for relation "movimientos_inventario" violates check
--     constraint "movimientos_inventario_origen_check"
--
--   Es el mismo tropiezo que ya tuvo el ERP de La Mexicana, de donde se portó
--   el recetario.
--
-- CÓMO LO RESUELVE
--   Lee la lista actual del propio CHECK y le SUMA `produccion`. No escribe una
--   lista fija a mano: eso borraría algún valor que el schema ya usa. Antes de
--   reemplazar el CHECK verifica que ninguna fila existente quede afuera.
--
-- Alcance: SOLO el schema `amasso`. No toca `public` ni ningún otro.
-- Idempotente: volver a correrlo deja el mismo resultado y lo dice por NOTICE.
-- =============================================================================

DO $prod$
DECLARE
  v_schema   text := 'amasso';
  v_tabla    text := 'movimientos_inventario';
  v_columna  text := 'origen';
  v_agregar  text[] := ARRAY['produccion'];
  v_conname  text;
  v_def      text;
  v_valores  text[];
  v_nuevo    text;
  v_faltan   text[];
  v_invalidos bigint;
BEGIN
  IF to_regclass(format('%I.%I', v_schema, v_tabla)) IS NULL THEN
    RAISE EXCEPTION 'falta %.% — corré antes 01_clonar_schema.sql', v_schema, v_tabla;
  END IF;

  SELECT conname, pg_get_constraintdef(oid) INTO v_conname, v_def
    FROM pg_constraint
   WHERE conrelid = format('%I.%I', v_schema, v_tabla)::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%(' || v_columna || ' = ANY%'
   LIMIT 1;

  IF v_conname IS NULL THEN
    RAISE NOTICE '%.%: sin CHECK de lista, no hace falta ampliarlo.', v_tabla, v_columna;
    RETURN;
  END IF;

  -- Postgres escribe el CHECK de dos formas y hay que entender las dos:
  --   ANY (ARRAY['a'::text, 'b'::text])   ← como vino del schema original
  --   ANY ('{a,b}'::text[])               ← como queda después de reescribirlo
  -- Leer solo la primera hace que una segunda corrida falle.
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1]) INTO v_valores
    FROM regexp_matches(v_def, $re$'([a-zA-Z_]+)'::text$re$, 'g') AS m;

  IF v_valores IS NULL OR cardinality(v_valores) = 0 THEN
    SELECT array_agg(DISTINCT btrim(x) ORDER BY btrim(x)) INTO v_valores
      FROM unnest(string_to_array(
             (regexp_match(v_def, $re$ANY \s*\(\s*'\{([^}]*)\}'$re$))[1], ',')) AS x
     WHERE btrim(x) <> '';
  END IF;

  IF v_valores IS NULL OR cardinality(v_valores) = 0 THEN
    RAISE EXCEPTION '%.%: no se pudo leer la lista de valores del CHECK. Definición: %',
      v_tabla, v_columna, v_def;
  END IF;

  v_faltan := '{}';
  FOREACH v_nuevo IN ARRAY v_agregar LOOP
    IF NOT (v_nuevo = ANY(v_valores)) THEN
      v_valores := array_append(v_valores, v_nuevo);
      v_faltan  := array_append(v_faltan, v_nuevo);
    END IF;
  END LOOP;

  IF cardinality(v_faltan) = 0 THEN
    RAISE NOTICE '%.%: ya acepta produccion, no hay nada que hacer.', v_tabla, v_columna;
    RETURN;
  END IF;

  -- Ninguna fila existente puede quedar fuera de la lista nueva.
  EXECUTE format(
    'SELECT count(*) FROM %I.%I WHERE %I IS NOT NULL AND NOT (%I = ANY($1))',
    v_schema, v_tabla, v_columna, v_columna
  ) INTO v_invalidos USING v_valores;
  IF v_invalidos > 0 THEN
    RAISE EXCEPTION 'Hay % filas en % con un % fuera de la lista. Revisalas antes de ajustar el CHECK.',
      v_invalidos, v_tabla, v_columna;
  END IF;

  EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', v_schema, v_tabla, v_conname);
  EXECUTE format(
    'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I = ANY(%L))',
    v_schema, v_tabla, v_conname, v_columna, v_valores
  );

  RAISE NOTICE '%.%: + % (ahora: %)',
    v_tabla, v_columna, array_to_string(v_faltan, ', '), array_to_string(v_valores, ', ');

  PERFORM pg_notify('pgrst', 'reload schema');
END;
$prod$;

-- -----------------------------------------------------------------------------
-- Verificación (solo lectura)
-- -----------------------------------------------------------------------------

-- 1) El CHECK ya acepta 'produccion'
SELECT conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint
 WHERE conrelid = 'amasso.movimientos_inventario'::regclass
   AND contype = 'c'
   AND pg_get_constraintdef(oid) LIKE '%(origen = ANY%';

-- 2) Las cuatro tablas del recetario están y vacías (vinieron en el clon)
SELECT c.relname::text AS tabla,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint AS filas
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'amasso'
   AND c.relname IN ('recetas','receta_items','producciones','produccion_items')
 ORDER BY 1;

-- 3) La función de costeo que usa la pantalla de recetas existe
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS argumentos
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'amasso' AND p.proname = 'fn_receta_costeo';

-- 4) Hace falta al menos un depósito: de ahí sale la materia prima y ahí entra
--    lo producido. Si esto devuelve 0 filas, cargá uno en el ERP
--    (Inventario → Depósitos / Ubicaciones) antes de fabricar.
SELECT id, nombre, tipo, activo
  FROM amasso.inventario_ubicaciones
 WHERE activo = true AND tipo <> 'camion'
 ORDER BY nombre;
