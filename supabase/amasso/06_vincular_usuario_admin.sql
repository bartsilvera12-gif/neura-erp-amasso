-- =============================================================================
-- 06 · VINCULAR UN USUARIO DE AUTH YA EXISTENTE CON LA EMPRESA
-- =============================================================================
-- Para cuando el usuario YA se creó en Supabase (dashboard, API, invitación) y
-- lo que falta es su fila en el ERP. Sin ella el login de Supabase funciona
-- pero el ERP no sabe de qué empresa es, y no entra a ninguna pantalla.
--
-- NO toca la contraseña ni nada de `auth.users`, salvo normalizar las columnas
-- de token si quedaron en NULL (ver más abajo). Busca al usuario POR EMAIL, así
-- que no hace falta copiar el uuid a mano.
--
-- ANTES DE EJECUTAR: revisar v_email.
-- Idempotente: si la fila del ERP ya existe, la reenlaza en vez de duplicar.
-- =============================================================================

DO $vinc$
DECLARE
  ---------------------------------------------------------------------------
  v_email      text := 'administrador@amasso.com';
  v_nombre     text := 'Administrador';
  v_rol        text := 'admin';
  ---------------------------------------------------------------------------
  v_tgt        text := 'amasso';
  v_empresa_id uuid := '26f2bd0a-3394-4256-a908-bf8784368fd5';
  -- Módulos que el resolver esconde salvo concesión explícita
  -- (src/lib/modulos/modulos-restringidos.ts). De los habilitados, solo este.
  v_restringidos text[] := ARRAY['tableros'];
  ---------------------------------------------------------------------------
  v_auth_id    uuid;
  v_usuario_id uuid;
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
    RAISE EXCEPTION 'falta el schema %', v_tgt;
  END IF;

  -- ------------------------------------------- 1. el usuario tiene que existir
  SELECT id INTO v_auth_id FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'no hay ningún usuario en auth.users con email %. Creálo primero en Supabase.', v_email;
  END IF;
  RAISE NOTICE 'auth: % encontrado (%)', v_email, v_auth_id;

  -- Que no esté ya atado a OTRA empresa de esta instancia por error.
  EXECUTE format(
    'SELECT id FROM %I.usuarios WHERE auth_user_id = %L AND empresa_id <> %L',
    v_tgt, v_auth_id, v_empresa_id
  ) INTO v_usuario_id;
  IF v_usuario_id IS NOT NULL THEN
    RAISE EXCEPTION 'ese usuario de Auth ya está atado a otra empresa dentro de %. Revisalo antes de seguir.', v_tgt;
  END IF;

  -- GoTrue lee varias columnas de token dentro de strings de Go que NO aceptan
  -- NULL. Si el usuario se creó desde el dashboard ya vienen bien; si se creó
  -- con un INSERT directo, no, y el login falla con "Database error querying
  -- schema". Esto solo pasa NULL a cadena vacía: no cambia ningún valor real.
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

  -- identities: sin esto GoTrue no deja entrar por email.
  IF to_regclass('auth.identities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = v_auth_id AND provider = 'email') THEN
    BEGIN
      EXECUTE format($q$
        INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        VALUES (gen_random_uuid(), %L, %L, jsonb_build_object('sub', %L, 'email', %L, 'email_verified', true),
                'email', now(), now(), now())$q$,
        v_auth_id, v_auth_id::text, v_auth_id::text, lower(v_email));
    EXCEPTION WHEN OTHERS THEN
      EXECUTE format($q$
        INSERT INTO auth.identities (id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        VALUES (gen_random_uuid(), %L, jsonb_build_object('sub', %L, 'email', %L), 'email', now(), now(), now())$q$,
        v_auth_id, v_auth_id::text, lower(v_email));
    END;
    RAISE NOTICE 'auth: faltaba la identity de email, se creó';
  END IF;

  -- ------------------------------------------------- 2. la fila del ERP
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
      'rol',          v_rol,
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
    RAISE NOTICE 'ERP: fila creada para % con rol % (%)', v_email, v_rol, v_usuario_id;
  ELSE
    EXECUTE format(
      'UPDATE %I.usuarios SET auth_user_id = %L, empresa_id = %L, rol = %L, activo = true, updated_at = now() WHERE id = %L',
      v_tgt, v_auth_id, v_empresa_id, v_rol, v_usuario_id);
    RAISE NOTICE 'ERP: la fila ya existía, se reenlazó al usuario de Auth (%)', v_usuario_id;
  END IF;

  -- ------------------------------- 3. módulos restringidos (solo `tableros`)
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
$vinc$;

-- Resultado: todos los usuarios de la empresa y su estado en Auth.
-- Los tres últimos tienen que dar true, true, >=1.
SELECT u.email, u.rol, u.activo, u.auth_user_id,
       au.email_confirmed_at IS NOT NULL AS email_confirmado,
       au.encrypted_password IS NOT NULL AS tiene_password,
       (SELECT count(*) FROM auth.identities i WHERE i.user_id = au.id) AS identities
FROM amasso.usuarios u
LEFT JOIN auth.users au ON au.id = u.auth_user_id
WHERE u.empresa_id = '26f2bd0a-3394-4256-a908-bf8784368fd5'
ORDER BY u.email;
