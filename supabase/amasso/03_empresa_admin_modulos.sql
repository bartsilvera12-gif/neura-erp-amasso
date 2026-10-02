-- =============================================================================
-- 03 · EMPRESA PROPIA + USUARIO ADMIN + MÓDULOS HABILITADOS
-- =============================================================================
-- Crea, SOLO dentro de `amasso` (+ el usuario en auth, que es de Supabase y es
-- compartido por diseño):
--
--   · empresa   Amasso   id = 26f2bd0a-3394-4256-a908-bf8784368fd5
--   · login     admin@amasso.com   rol `admin`
--   · empresa_modulos con EXACTAMENTE los 19 módulos pedidos
--   · usuario_modulos para `tableros`, que es un módulo RESTRINGIDO
--
-- Sobre los módulos: el sidebar se arma con empresa_modulos ∩ usuario_modulos.
-- OJO — si `empresa_modulos` quedara VACÍA, el ERP muestra TODOS los módulos
-- (retrocompatibilidad, ver src/lib/modulos/resolve-effective-modules.ts). Por
-- eso estas filas no son opcionales: son las que recortan el menú.
--
-- ANTES DE EJECUTAR: cambiar v_password.
-- Idempotente: se puede volver a correr.
-- =============================================================================

DO $admin$
DECLARE
  ---------------------------------------------------------------------------
  v_tgt        text := 'amasso';
  v_empresa_id uuid := '26f2bd0a-3394-4256-a908-bf8784368fd5';
  v_nombre     text := 'Amasso';
  v_email      text := 'admin@amasso.com';
  v_password   text := 'CambiarEsto123!';   -- <<<<<< CAMBIAR ANTES DE EJECUTAR
  ---------------------------------------------------------------------------
  -- Los 19 módulos pedidos, con los slugs que el CÓDIGO realmente evalúa
  -- (Sidebar.tsx + route-slug-map.ts). Tres equivalencias:
  --   · "RRHH"            → slug `usuarios` (así se llama la entrada del menú).
  --   · "Ventas"          → slug `ventas`, que en el menú figura como "Caja".
  --   · "Notas de crédito"→ slug `notas_credito`, con guion BAJO (no guion medio).
  --   · "Recetas"        → slug `recetas`, la fila YA está en el catálogo heredado.
  --                        En el ERP de origen no se usaba porque ese repo no
  --                        tenía el código; acá sí (portado del de La Mexicana).
  --
  -- NO se incluye `contabilidad`: no tiene ninguna vista propia en el código
  -- (no aparece en el sidebar ni en route-slug-map), así que habilitarlo no
  -- agregaría ninguna pantalla. El plan de cuentas y lo contable que sí existe
  -- vive bajo `configuracion`.
  v_slugs text[] := ARRAY[
    'agenda', 'clientes', 'cobranzas', 'comisiones', 'compras', 'configuracion',
    'dashboard', 'gastos', 'gerencia', 'gestion-clientes', 'guardias',
    'inventario', 'notas_credito', 'pagos', 'recetas', 'reportes', 'tableros',
    'usuarios', 'ventas'
  ];

  -- El catálogo heredado puede no tener fila para alguno de los 18 (el schema
  -- origen venía de un ERP que no usaba Guardias ni Tableros). Se asegura una
  -- fila por cada slug pedido, con el nombre que muestra el menú. Solo inserta
  -- lo que falta: si la fila ya existe, no se le toca el nombre.
  --
  -- OJO con `cobros`: el catálogo heredado tiene esa fila y parece "Cobranzas",
  -- pero ese slug no aparece en ninguna parte del código — el que se evalúa es
  -- `cobranzas`. Lo mismo con presupuestos/recepcion/recibos/remision: son filas
  -- muertas del catálogo y no se otorgan. `recetas` NO es una de ellas: la fila
  -- existía sin código detrás, y el código se portó del ERP de La Mexicana.
  v_catalogo text[][] := ARRAY[
    ARRAY['agenda',           'Agenda'],
    ARRAY['clientes',         'Clientes'],
    ARRAY['cobranzas',        'Cobranzas'],
    ARRAY['comisiones',       'Comisiones'],
    ARRAY['compras',          'Compras'],
    ARRAY['configuracion',    'Configuración'],
    ARRAY['dashboard',        'Dashboard'],
    ARRAY['gastos',           'Gastos y Servicios'],
    ARRAY['gerencia',         'Gerencia'],
    ARRAY['gestion-clientes', 'Gestión Clientes'],
    ARRAY['guardias',         'Guardias'],
    ARRAY['inventario',       'Inventario'],
    ARRAY['notas_credito',    'Notas de crédito'],
    ARRAY['pagos',            'Pagos'],
    ARRAY['recetas',          'Recetas'],
    ARRAY['reportes',         'Reportes'],
    ARRAY['tableros',         'Tableros'],
    ARRAY['usuarios',         'RRHH'],
    ARRAY['ventas',           'Ventas']
  ];

  -- Módulos RESTRINGIDOS (src/lib/modulos/modulos-restringidos.ts): habilitarlos
  -- para la empresa NO alcanza — el resolver los esconde a todo el mundo, incluso
  -- a los administradores, salvo que haya una fila explícita en `usuario_modulos`.
  -- De los 18 pedidos, el único restringido es `tableros`.
  v_restringidos text[] := ARRAY['tableros'];
  ---------------------------------------------------------------------------
  v_auth_id    uuid;
  v_usuario_id uuid;
  v_crypt_schema text;
  v_cols      text;
  v_vals      text;
  v_faltan    text;
  v_n         int;
  v_i         int;
  r           RECORD;
  v_payload   jsonb;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_tgt) THEN
    RAISE EXCEPTION 'falta el schema % — corré antes 01_clonar_schema.sql', v_tgt;
  END IF;
  IF v_password = 'CambiarEsto123!' THEN
    RAISE WARNING 'Estás usando la contraseña de ejemplo. Cambiala en v_password o desde el ERP al primer ingreso.';
  END IF;

  -- ------------------------------------------------------- 1. usuario en Auth
  SELECT n.nspname INTO v_crypt_schema
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'crypt' AND p.pronargs = 2
  ORDER BY CASE n.nspname WHEN 'extensions' THEN 1 WHEN 'public' THEN 2 ELSE 3 END
  LIMIT 1;

  IF v_crypt_schema IS NULL THEN
    RAISE EXCEPTION 'falta pgcrypto (función crypt). Instalalo: CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;';
  END IF;

  SELECT id INTO v_auth_id FROM auth.users WHERE lower(email) = lower(v_email);

  IF v_auth_id IS NULL THEN
    v_auth_id := gen_random_uuid();
    EXECUTE format($q$
      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000000', %L, 'authenticated', 'authenticated',
        %L, %I.crypt(%L, %I.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('nombre', %L), now(), now()
      )$q$,
      v_auth_id, lower(v_email), v_crypt_schema, v_password, v_crypt_schema, 'Administrador');

    -- identities: GoTrue lo necesita para login por email
    IF to_regclass('auth.identities') IS NOT NULL THEN
      BEGIN
        EXECUTE format($q$
          INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
          VALUES (gen_random_uuid(), %L, %L, jsonb_build_object('sub', %L, 'email', %L, 'email_verified', true),
                  'email', now(), now(), now())$q$,
          v_auth_id, v_auth_id::text, v_auth_id::text, lower(v_email));
      EXCEPTION WHEN OTHERS THEN
        -- versiones viejas de GoTrue no tienen provider_id
        EXECUTE format($q$
          INSERT INTO auth.identities (id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
          VALUES (gen_random_uuid(), %L, jsonb_build_object('sub', %L, 'email', %L), 'email', now(), now(), now())$q$,
          v_auth_id, v_auth_id::text, lower(v_email));
      END;
    END IF;
    RAISE NOTICE 'auth: usuario % creado (%)', v_email, v_auth_id;
  ELSE
    RAISE NOTICE 'auth: el usuario % ya existía (%) — no se toca su contraseña', v_email, v_auth_id;
  END IF;

  -- --------------------------------------------------------------- 2. empresa
  -- Se insertan solo las columnas que realmente existen en la tabla clonada.
  -- data_schema queda NULL a propósito: así el ERP usa APP_DB_SCHEMA (= amasso)
  -- y no intenta resolver un schema tenant aparte.
  v_payload := jsonb_build_object(
    'id',             v_empresa_id::text,
    'nombre_empresa', v_nombre,
    'nombre',         v_nombre,
    'razon_social',   v_nombre,
    'email',          lower(v_email),
    'activo',         'true',
    'created_at',     now()::text,
    'updated_at',     now()::text
  );

  SELECT string_agg(quote_ident(k), ', ' ORDER BY k),
         string_agg(format('%L::%s', v_payload ->> k, a.atttypid::regtype::text), ', ' ORDER BY k)
  INTO v_cols, v_vals
  FROM jsonb_object_keys(v_payload) AS k
  JOIN pg_attribute a ON a.attname = k
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = v_tgt AND c.relname = 'empresas' AND a.attnum > 0 AND NOT a.attisdropped;

  -- Columnas obligatorias que este script no cubre (si aparece alguna, avisá)
  SELECT string_agg(a.attname, ', ') INTO v_faltan
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = v_tgt AND c.relname = 'empresas'
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
    AND ad.adbin IS NULL AND a.attidentity = ''
    AND NOT (v_payload ? a.attname);
  IF v_faltan IS NOT NULL THEN
    RAISE WARNING 'empresas: columnas NOT NULL sin default no cubiertas: %', v_faltan;
  END IF;

  EXECUTE format('INSERT INTO %I.empresas (%s) VALUES (%s) ON CONFLICT (id) DO NOTHING', v_tgt, v_cols, v_vals);
  RAISE NOTICE 'empresa: % (%)', v_nombre, v_empresa_id;

  -- ---------------------------------------------------------- 3. usuario ERP
  EXECUTE format('SELECT id FROM %I.usuarios WHERE lower(email) = %L', v_tgt, lower(v_email)) INTO v_usuario_id;

  IF v_usuario_id IS NULL THEN
    v_usuario_id := gen_random_uuid();
    v_payload := jsonb_build_object(
      'id',           v_usuario_id::text,
      'auth_user_id', v_auth_id::text,
      'empresa_id',   v_empresa_id::text,
      'email',        lower(v_email),
      'nombre',       'Administrador',
      'rol',          'admin',
      'activo',       'true',
      'created_at',   now()::text,
      'updated_at',   now()::text
    );

    SELECT string_agg(quote_ident(k), ', ' ORDER BY k),
           string_agg(format('%L::%s', v_payload ->> k, a.atttypid::regtype::text), ', ' ORDER BY k)
    INTO v_cols, v_vals
    FROM jsonb_object_keys(v_payload) AS k
    JOIN pg_attribute a ON a.attname = k
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_tgt AND c.relname = 'usuarios' AND a.attnum > 0 AND NOT a.attisdropped;

    SELECT string_agg(a.attname, ', ') INTO v_faltan
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = v_tgt AND c.relname = 'usuarios'
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
      AND ad.adbin IS NULL AND a.attidentity = ''
      AND NOT (v_payload ? a.attname);
    IF v_faltan IS NOT NULL THEN
      RAISE WARNING 'usuarios: columnas NOT NULL sin default no cubiertas: %', v_faltan;
    END IF;

    EXECUTE format('INSERT INTO %I.usuarios (%s) VALUES (%s)', v_tgt, v_cols, v_vals);
    RAISE NOTICE 'usuario ERP: % rol admin (%)', v_email, v_usuario_id;
  ELSE
    EXECUTE format('UPDATE %I.usuarios SET auth_user_id = %L, empresa_id = %L, rol = ''admin'' WHERE id = %L',
                   v_tgt, v_auth_id, v_empresa_id, v_usuario_id);
    RAISE NOTICE 'usuario ERP: ya existía, se reenlazó a la empresa (%)', v_usuario_id;
  END IF;

  -- ------------------------ 4. catálogo: asegurar una fila por slug pedido
  FOR v_i IN 1 .. array_length(v_catalogo, 1)
  LOOP
    EXECUTE format(
      'INSERT INTO %I.modulos (nombre, slug) SELECT %L, %L '
      || 'WHERE NOT EXISTS (SELECT 1 FROM %I.modulos WHERE lower(btrim(slug)) = %L)',
      v_tgt, v_catalogo[v_i][2], v_catalogo[v_i][1], v_tgt, v_catalogo[v_i][1]
    );
  END LOOP;

  -- ------------------------------------------------------ 5. empresa_modulos
  EXECUTE format(
    'INSERT INTO %I.empresa_modulos (empresa_id, modulo_id, activo) '
    || 'SELECT %L::uuid, m.id, true FROM %I.modulos m WHERE lower(btrim(m.slug)) = ANY (%L::text[]) '
    || 'ON CONFLICT DO NOTHING',
    v_tgt, v_empresa_id, v_tgt, v_slugs
  );

  -- Si el módulo ya estaba pero desactivado, activarlo
  EXECUTE format(
    'UPDATE %I.empresa_modulos em SET activo = true FROM %I.modulos m '
    || 'WHERE em.modulo_id = m.id AND em.empresa_id = %L::uuid AND lower(btrim(m.slug)) = ANY (%L::text[])',
    v_tgt, v_tgt, v_empresa_id, v_slugs
  );

  -- Y desactivar cualquier otro que se hubiese colado
  EXECUTE format(
    'UPDATE %I.empresa_modulos em SET activo = false FROM %I.modulos m '
    || 'WHERE em.modulo_id = m.id AND em.empresa_id = %L::uuid AND NOT (lower(btrim(m.slug)) = ANY (%L::text[]))',
    v_tgt, v_tgt, v_empresa_id, v_slugs
  );

  EXECUTE format('SELECT count(*) FROM %I.empresa_modulos WHERE empresa_id = %L::uuid AND activo',
                 v_tgt, v_empresa_id) INTO v_n;
  RAISE NOTICE 'módulos habilitados para la empresa: %', v_n;

  -- ------------------------------- 6. usuario_modulos de módulos restringidos
  -- Solo para los restringidos. Un rol `admin` ya ve todo lo que esté activo en
  -- `empresa_modulos` sin pasar por la intersección, así que cargarle filas para
  -- los 18 no agregaría nada — pero sí ensuciaría la pantalla de permisos y,
  -- para cualquier usuario que NO sea admin, congelaría su menú en la lista de
  -- hoy. Con una fila para `tableros` únicamente, el admin sigue viendo todo lo
  -- habilitado y además el tablero restringido.
  SELECT string_agg(a.attname, ', ') INTO v_faltan
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = v_tgt AND c.relname = 'usuario_modulos'
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
    AND ad.adbin IS NULL AND a.attidentity = ''
    AND a.attname NOT IN ('usuario_id', 'modulo_id');
  IF v_faltan IS NOT NULL THEN
    RAISE WARNING 'usuario_modulos: columnas NOT NULL sin default no cubiertas: %', v_faltan;
  END IF;

  EXECUTE format(
    'INSERT INTO %I.usuario_modulos (usuario_id, modulo_id) '
    || 'SELECT %L::uuid, m.id FROM %I.modulos m '
    || 'WHERE lower(btrim(m.slug)) = ANY (%L::text[]) '
    || '  AND NOT EXISTS (SELECT 1 FROM %I.usuario_modulos um WHERE um.usuario_id = %L::uuid AND um.modulo_id = m.id)',
    v_tgt, v_usuario_id, v_tgt, v_restringidos, v_tgt, v_usuario_id
  );

  EXECUTE format('SELECT count(*) FROM %I.usuario_modulos WHERE usuario_id = %L::uuid', v_tgt, v_usuario_id) INTO v_n;
  RAISE NOTICE 'usuario_modulos del admin (solo restringidos): %', v_n;

  -- Slugs pedidos que no existen en el catálogo (no debería quedar ninguno)
  FOR r IN
    EXECUTE format(
      'SELECT s AS slug FROM unnest(%L::text[]) AS s '
      || 'WHERE NOT EXISTS (SELECT 1 FROM %I.modulos m WHERE lower(btrim(m.slug)) = s)',
      v_slugs, v_tgt)
  LOOP
    RAISE WARNING 'módulo sin entrada en el catálogo (se omite): %', r.slug;
  END LOOP;

  PERFORM pg_notify('pgrst', 'reload schema');
END;
$admin$;

-- Resultado 1: módulos activos de la empresa (esperado: 19 en activo = true)
SELECT m.slug, m.nombre, em.activo
FROM amasso.empresa_modulos em
JOIN amasso.modulos m ON m.id = em.modulo_id
WHERE em.empresa_id = '26f2bd0a-3394-4256-a908-bf8784368fd5'
ORDER BY em.activo DESC, m.slug;

-- Resultado 2: concesiones explícitas del admin (esperado: solo `tableros`)
SELECT u.email, m.slug
FROM amasso.usuario_modulos um
JOIN amasso.usuarios u ON u.id = um.usuario_id
JOIN amasso.modulos m ON m.id = um.modulo_id
WHERE lower(u.email) = 'admin@amasso.com'
ORDER BY m.slug;
