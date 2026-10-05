-- =============================================================================
-- 02 · CATÁLOGOS DE PRODUCTO  distribuidorajmerp → amasso
-- =============================================================================
-- Copia las dos tablas que son catálogo DE PRODUCTO, no datos de negocio:
--
--   · `modulos`          la lista de módulos que existen en el ERP. Sin estas
--                        filas el sidebar no puede resolver permisos.
--   · `dashboard_views`  las pestañas del tablero principal (Comercial,
--                        Financiero, Inventario, Ventas). Sin ellas el Dashboard
--                        muestra "Sin vistas asignadas", porque el resolver cae
--                        en "todas las del catálogo" y el catálogo está vacío.
--
-- Cómo se distingue un catálogo de un dato de negocio: **los catálogos no tienen
-- `empresa_id`**. Todo lo demás que tiene filas en el origen (plan_cuentas,
-- categorias_productos, empresa_sifen_config, factura_correlativos…) sí lo tiene,
-- es de la otra empresa, y copiarlo sería contaminar el ERP nuevo.
--
-- No copia empresas, usuarios ni ninguna tabla de negocio.
--
-- Es idempotente: se puede volver a correr (ON CONFLICT DO NOTHING).
-- =============================================================================

DO $seed$
DECLARE
  v_src text := 'distribuidorajmerp';   -- origen: schema del ERP de Distribuidora JM
  v_tgt text := 'amasso';
  v_tabla text;
  v_cols text;
  v_n int;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);

  FOREACH v_tabla IN ARRAY ARRAY['modulos', 'dashboard_views']
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_tgt AND c.relname = v_tabla AND a.attnum > 0 AND NOT a.attisdropped
      -- solo columnas que también existen en el origen
      AND EXISTS (
        SELECT 1 FROM pg_attribute a2
        JOIN pg_class c2 ON c2.oid = a2.attrelid
        JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
        WHERE n2.nspname = v_src AND c2.relname = v_tabla
          AND a2.attname = a.attname AND a2.attnum > 0 AND NOT a2.attisdropped
      );

    IF v_cols IS NULL THEN
      RAISE EXCEPTION 'no se encontró la tabla % en % o %', v_tabla, v_src, v_tgt;
    END IF;

    -- Guarda: si la tabla tuviera empresa_id no es catálogo, son datos de otra
    -- empresa y no se copian.
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = v_src AND c.relname = v_tabla AND a.attname = 'empresa_id'
        AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION '% tiene empresa_id: no es catálogo de producto, no se copia', v_tabla;
    END IF;

    EXECUTE format(
      'INSERT INTO %I.%I (%s) SELECT %s FROM %I.%I ON CONFLICT DO NOTHING',
      v_tgt, v_tabla, v_cols, v_cols, v_src, v_tabla
    );

    EXECUTE format('SELECT count(*) FROM %I.%I', v_tgt, v_tabla) INTO v_n;
    RAISE NOTICE 'catálogo %: % filas en %', v_tabla, v_n, v_tgt;
  END LOOP;
END;
$seed$;

-- Listado resultante (para confirmar los slugs disponibles):
SELECT slug, nombre FROM amasso.modulos ORDER BY slug;

-- Pestañas del tablero principal (esperado: comercial, financiero, inventario, ventas):
SELECT slug, nombre, orden, activo FROM amasso.dashboard_views ORDER BY orden;
