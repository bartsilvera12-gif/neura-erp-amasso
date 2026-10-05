-- =============================================================================
-- 06 · AGREGAR UN USUARIO ADMIN (reusable)
-- =============================================================================
-- Da de alta un usuario con rol `admin` en la empresa de Amasso: lo crea en
-- `auth` (que es de Supabase y compartido por toda la instancia) y en
-- `amasso.usuarios`, y le concede los módulos restringidos.
--
-- ANTES DE EJECUTAR: cambiar v_email y v_password.
--
-- Idempotente: si el usuario ya existe no lo duplica. Y si ya existía con otra
-- contraseña, la PISA con la de acá — es la forma de recuperar un acceso
-- perdido sin tocar a nadie más.
--
-- Alcance: una fila en `auth.users`, una en `auth.identities`, una en
-- `amasso.usuarios` y una en `amasso.usuario_modulos`. No toca ningún otro
-- usuario de la instancia ni ningún otro schema.
-- =============================================================================

DO $nuevo$
DECLARE
  ---------------------------------------------------------------------------
  v_email      text := 'administrador@amasso.com';
  v_password   text := 'CambiarEsto123!';   -- <<<<<< CAMBIAR ANTES DE EJECUTAR
  v_nombre     text := 'Administrador';
  ---------------------------------------------------------------------------
  v_tgt        text := 'amasso';
  v_empresa_id uuid := '26f2bd0a-3394-4256-a908-bf8784368fd5';
  -- Módulos que el resolver esconde salvo concesión explícita
  -- (src/lib/modulos/modulos-restringidos.ts). De los habilitados, solo este.
  v_restringidos text[] := ARRAY['tableros'];
  ---------------------------------------------------------------------------
  v_auth_id    uuid;
  v_usuario_id uuid;
  v_crypt      text;
  v_col        text;
  v_sets       text;
  v_cols       text;
  v_vals       text;
  v_faltan     text;
  v_payload    jsonb;
  v_n          int;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_tgt) THEN
    RAISE EXCEPTION 'falta el schema % — corré antes 01_clonar_schema.sql', v_tgt;
  END IF;
  IF v_password = 'CambiarEsto123!' THEN
    RAISE WARNING 'Estás usando la contraseña de ejemplo. Cambiala en v_password.';
  END IF;

  -- pgcrypto puede estar en `extensions` o en `public` según la instancia.
  SELECT n.nspname INTO v_crypt
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'crypt' AND p.pronargs = 2
  ORDER BY CASE n.nspname WHEN 'extensions' THEN 1 WHEN 'public' THEN 2 ELSE 3 END
  LIMIT 1;
  IF v_crypt IS NULL THEN
    RAISE EXCEPTION 'falta pgcrypto (función crypt). Instalalo: CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;';
  END IF;

  -- ------------------------------------------------------- 1. usuario en Auth
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
      v_auth_id, lower(v_email), v_crypt, v_password, v_crypt, v_nombre);
    RAISE NOTICE 'auth: usuario % creado (%)', v_email, v_auth_id;
  ELSE
    -- Ya existía: se le pisa la contraseña. Es el caso "perdí el acceso".
    EXECUTE format(
      'UPDATE auth.users SET encrypted_password = %I.crypt(%L, %I.gen_salt(''bf'')), '
      || 'email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() WHERE id = %L',
      v_crypt, v_password, v_crypt, v_auth_id);
    RAISE NOTICE 'auth: el usuario % ya existía (%) — se le actualizó la contraseña', v_email, v_auth_id;
  END IF;

  -- identities: GoTrue lo necesita para el login por email.
  IF to_regclass('auth.identities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = v_auth_id AND provider = 'email') THEN
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
    RAISE NOTICE 'auth: identity de email creada';
  END IF;

  -- GoTrue lee varias columnas de token dentro de strings de Go que NO aceptan
  -- NULL. Sin esto el login falla con "Database error querying schema", que
  -- suena a problema del schema del ERP y no tiene nada que ver.
  v_sets := '';
  FOREACH v_col IN ARRAY ARRAY[
    'confirmation_token', 'recovery_token', 'email_change',
    'email_change_token_new', 'email_change_token_current',
    'phone_change', 'phone_change_token', 'reauthentication_token'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = 'auth.users'::regclass
        AND a.attname = v_col AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      v_sets := v_sets || format('%I = coalesce(%I, %L), ', v_col, v_col, '');
    END IF;
  END LOOP;
  IF v_sets <> '' THEN
    EXECUTE format('UPDATE auth.users SET %s updated_at = now() WHERE id = %L', v_sets, v_auth_id);
  END IF;

  -- ---------------------------------------------------------- 2. usuario ERP
  EXECUTE format('SELECT id FROM %I.usuarios WHERE lower(email) = %L', v_tgt, lower(v_email))
  INTO v_usuario_id;

  IF v_usuario_id IS NULL THEN
    v_usuario_id := gen_random_uuid();
    v_payload := jsonb_build_object(
      'id',           v_usuario_id::text,
      'auth_user_id', v_auth_id::text,
      'empresa_id',   v_empresa_id::text,
      'email',        lower(v_email),
      'nombre',       v_nombre,
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
    EXECUTE format(
      'UPDATE %I.usuarios SET auth_user_id = %L, empresa_id = %L, rol = ''admin'', activo = true, updated_at = now() WHERE id = %L',
      v_tgt, v_auth_id, v_empresa_id, v_usuario_id);
    RAISE NOTICE 'usuario ERP: ya existía, se reenlazó y quedó como admin activo (%)', v_usuario_id;
  END IF;

  -- -------------------------------- 3. módulos restringidos (solo `tableros`)
  -- El rol admin ya ve todo lo activo en empresa_modulos; los restringidos no,
  -- hace falta la fila explícita.
  EXECUTE format(
    'INSERT INTO %I.usuario_modulos (usuario_id, modulo_id) '
    || 'SELECT %L::uuid, m.id FROM %I.modulos m '
    || 'WHERE lower(btrim(m.slug)) = ANY (%L::text[]) '
    || '  AND NOT EXISTS (SELECT 1 FROM %I.usuario_modulos um WHERE um.usuario_id = %L::uuid AND um.modulo_id = m.id)',
    v_tgt, v_usuario_id, v_tgt, v_restringidos, v_tgt, v_usuario_id
  );
  EXECUTE format('SELECT count(*) FROM %I.usuario_modulos WHERE usuario_id = %L::uuid', v_tgt, v_usuario_id)
  INTO v_n;
  RAISE NOTICE 'usuario_modulos (solo restringidos): %', v_n;

  PERFORM pg_notify('pgrst', 'reload schema');
END;
$nuevo$;

-- Resultado: los admin de la empresa y su estado en Auth
SELECT u.email, u.rol, u.activo,
       au.email_confirmed_at IS NOT NULL                     AS email_confirmado,
       au.encrypted_password IS NOT NULL                     AS tiene_password,
       (SELECT count(*) FROM auth.identities i WHERE i.user_id = au.id) AS identities,
       au.confirmation_token IS NULL                         AS token_en_null_ojo
FROM amasso.usuarios u
JOIN auth.users au ON au.id = u.auth_user_id
WHERE u.empresa_id = '26f2bd0a-3394-4256-a908-bf8784368fd5'
ORDER BY u.email;
