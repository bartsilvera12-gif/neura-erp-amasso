-- =============================================================================
-- 07 · AUDITORÍA (solo lectura) — correr cuando se quiera revisar la salud
-- =============================================================================
-- No modifica nada. Devuelve SIETE resultados; el SQL Editor muestra uno por
-- bloque, así que conviene correrlos de a uno o mirar la pestaña de resultados.
--
-- Lo que busca, en orden de importancia:
--   1. CHECK de vocabulario que no acepte lo que el código escribe. Es la
--      familia de bugs que ya mordió dos veces (`produccion`, `carga_proveedor`):
--      la tabla viene del schema de otro sistema y sus CHECK enumeran los
--      valores de AQUEL, no los de este código.
--   2. Fugas: cualquier dependencia de `amasso` hacia otro schema del ERP.
--   3. Tablas sin RLS.
--   4. Grants a `anon` (no debería tener ninguno).
--   5. Catálogos de producto sembrados.
--   6. Realtime: paridad con el origen.
--   7. Conteo de objetos vs el origen.
-- =============================================================================


-- ─── 1 · CHECK de vocabulario ────────────────────────────────────────────────
-- Lista todos los CHECK que enumeran valores, con la lista que aceptan. Hay que
-- leerlos contra lo que escribe el código: si el código manda un valor que no
-- está acá, la operación falla con "violates check constraint".
--
-- Columnas a mirar con más atención, porque son las que más valores nuevos
-- reciben: movimientos_inventario.origen / tipo / documento_tipo,
-- ventas.estado / metodo_pago, caja_movimientos.medio_pago, compras.estado,
-- repartos.estado, cobros_*.estado.
SELECT c.relname::text                AS tabla,
       co.conname::text               AS constraint,
       pg_get_constraintdef(co.oid)   AS acepta
FROM pg_constraint co
JOIN pg_class c      ON c.oid = co.conrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
WHERE n.nspname = 'amasso'
  AND co.contype = 'c'
  AND pg_get_constraintdef(co.oid) LIKE '%= ANY%'
ORDER BY c.relname, co.conname;


-- ─── 2 · FUGAS (esperado: 0 filas) ───────────────────────────────────────────
-- Cualquier fila acá significa que `amasso` quedó colgado de otro schema.
-- `auth` se excluye: auth.users es de Supabase y se comparte por diseño.
SELECT 'fuga_fk' AS tipo, c.relname::text AS objeto,
       co.conname::text || ' -> ' || rn.nspname::text || '.' || rf.relname::text AS detalle
FROM pg_constraint co
JOIN pg_class c ON c.oid = co.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class rf ON rf.oid = co.confrelid
JOIN pg_namespace rn ON rn.oid = rf.relnamespace
WHERE n.nspname = 'amasso' AND co.contype = 'f'
  AND rn.nspname NOT IN ('amasso', 'auth')
UNION ALL
SELECT 'fuga_funcion', p.proname::text, 'cuerpo o search_path referencia otro schema'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'amasso' AND p.prokind IN ('f','p')
  AND (coalesce(p.prosrc,'') || ' ' || coalesce(array_to_string(p.proconfig, ' '), ''))
      ~ '(^|[^a-zA-Z0-9_])(distribuidorajmerp|instemaq|zentra_erp|neura)([^a-zA-Z0-9_]|$)'
UNION ALL
SELECT 'fuga_policy', c.relname::text, pol.polname::text
FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'amasso'
  AND (coalesce(pg_get_expr(pol.polqual, pol.polrelid),'')
    || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),''))
      ~ '(^|[^a-zA-Z0-9_])(distribuidorajmerp|instemaq|zentra_erp)([^a-zA-Z0-9_]|$)'
UNION ALL
SELECT 'fuga_vista', c.relname::text, 'definición referencia otro schema'
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'amasso' AND c.relkind IN ('v','m')
  AND pg_get_viewdef(c.oid, true) ~ '(^|[^a-zA-Z0-9_])(distribuidorajmerp|instemaq|zentra_erp)([^a-zA-Z0-9_]|$)'
UNION ALL
SELECT 'fuga_default', c.relname::text, a.attname::text
FROM pg_attrdef ad
JOIN pg_class c ON c.oid = ad.adrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
WHERE n.nspname = 'amasso'
  AND pg_get_expr(ad.adbin, ad.adrelid) ~ '(^|[^a-zA-Z0-9_])(distribuidorajmerp|instemaq|zentra_erp)([^a-zA-Z0-9_]|$)';


-- ─── 3 · RLS ─────────────────────────────────────────────────────────────────
-- Tablas sin RLS, y tablas con RLS pero sin ninguna policy (que en la práctica
-- las deja cerradas para todo el mundo salvo service_role).
SELECT c.relname::text AS tabla,
       c.relrowsecurity AS rls_activo,
       count(pol.polname) AS policies,
       CASE
         WHEN NOT c.relrowsecurity THEN 'sin RLS'
         WHEN count(pol.polname) = 0 THEN 'RLS sin policies'
         ELSE 'ok'
       END AS estado
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
WHERE n.nspname = 'amasso' AND c.relkind = 'r'
GROUP BY 1,2
HAVING NOT c.relrowsecurity OR count(pol.polname) = 0
ORDER BY 1;


-- ─── 4 · GRANTS a `anon` (esperado: 0 filas) ─────────────────────────────────
-- `anon` es el rol de la clave pública del navegador. No debería poder tocar
-- ninguna tabla del ERP.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'amasso' AND grantee = 'anon'
ORDER BY 1,2;


-- ─── 5 · CATÁLOGOS DE PRODUCTO ───────────────────────────────────────────────
-- Las dos tablas que NO tienen empresa_id y que el script 02 siembra. Si alguna
-- queda en 0, el módulo que depende de ella aparece vacío.
SELECT 'modulos'         AS catalogo, count(*) AS filas, 37 AS esperado_aprox FROM amasso.modulos
UNION ALL
SELECT 'dashboard_views', count(*), 4 FROM amasso.dashboard_views;


-- ─── 6 · REALTIME ────────────────────────────────────────────────────────────
-- Tablas publicadas en `supabase_realtime`, comparadas con el origen.
SELECT coalesce(a.tablename, j.tablename) AS tabla,
       (a.tablename IS NOT NULL) AS en_amasso,
       (j.tablename IS NOT NULL) AS en_origen
FROM (SELECT tablename FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'amasso') a
FULL JOIN (SELECT tablename FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'distribuidorajmerp') j
  ON j.tablename = a.tablename
WHERE (a.tablename IS NULL) <> (j.tablename IS NULL)   -- solo las que NO coinciden
ORDER BY 1;


-- ─── 7 · OBJETOS vs ORIGEN (ok = true en todas) ──────────────────────────────
SELECT kind AS chequeo, origen, destino, (origen = destino) AS ok
FROM (
  SELECT CASE c.relkind WHEN 'r' THEN 'tablas' WHEN 'v' THEN 'vistas'
                        WHEN 'm' THEN 'matviews' WHEN 'S' THEN 'secuencias'
                        WHEN 'i' THEN 'indices' END AS kind,
         count(*) FILTER (WHERE n.nspname = 'distribuidorajmerp') AS origen,
         count(*) FILTER (WHERE n.nspname = 'amasso')             AS destino
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('distribuidorajmerp','amasso') AND c.relkind IN ('r','v','m','S','i')
  GROUP BY 1
  UNION ALL
  SELECT 'funciones',
         count(*) FILTER (WHERE n.nspname = 'distribuidorajmerp'),
         count(*) FILTER (WHERE n.nspname = 'amasso')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('distribuidorajmerp','amasso')
  UNION ALL
  SELECT 'policies',
         count(*) FILTER (WHERE n.nspname = 'distribuidorajmerp'),
         count(*) FILTER (WHERE n.nspname = 'amasso')
  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('distribuidorajmerp','amasso')
  UNION ALL
  SELECT 'triggers',
         count(*) FILTER (WHERE n.nspname = 'distribuidorajmerp'),
         count(*) FILTER (WHERE n.nspname = 'amasso')
  FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('distribuidorajmerp','amasso') AND NOT tg.tgisinternal
) t
ORDER BY 1;
