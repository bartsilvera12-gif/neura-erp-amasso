# Neura ERP · Amasso — puesta en marcha

ERP independiente, copia de `neura-erp-distribuidorajm`, con su propio schema
Postgres, su propia empresa y su propio login. No comparte datos ni historial
git con el ERP de origen.

| | |
|---|---|
| Repo | `bartsilvera12-gif/neura-erp-amasso` |
| Schema de datos | `amasso` (clonado de `distribuidorajmerp`) |
| URL | `http://amasso.neura.com.py` (HTTP: el TLS lo termina Cloudflare) |
| Empresa id | `26f2bd0a-3394-4256-a908-bf8784368fd5` |
| Login admin | `admin@amasso.com` (rol `admin`) |
| App Coolify | `neura-erp-amasso` · uuid `ihi0rqlifmazhdsa0ojspfls` |

---

## 1 · Base de datos

Los scripts están en `supabase/amasso/`. Se pegan en el SQL Editor de Supabase
self-hosted **en este orden**, uno por vez, leyendo los `NOTICE` que devuelve
cada uno.

| # | Archivo | Qué hace |
|---|---|---|
| 00 | `00_diagnostico_schema_origen.sql` | Opcional, solo lectura. Confirma que `distribuidorajmerp` es el origen y que `amasso` está libre. |
| 01 | `01_clonar_schema.sql` | Crea `amasso` como copia estructural de `distribuidorajmerp`, **sin datos**. |
| 02 | `02_catalogo_modulos.sql` | Copia el catálogo `modulos` (lista de módulos del producto). |
| 03 | `03_empresa_admin_modulos.sql` | Empresa + usuario admin + los 18 módulos habilitados. |
| 04 | `04_verificacion.sql` | Solo lectura. Compara origen vs destino y busca fugas. |

### Antes de ejecutar

El schema origen es **`distribuidorajmerp`** y ya está fijado en los scripts 01,
02 y 04: no hay nada que ajustar ahí. Lo único que tenés que tocar es
**`v_password` en el 03**, antes de ejecutarlo.

El 01 anula el `statement_timeout` para su propia transacción, porque el SQL
Editor impone uno corto y el clon de un schema grande tarda minutos.

### Cómo está organizada la base

La instancia usa **un schema autocontenido por cliente**: cada schema tiene sus
propias `empresas`, `usuarios`, `modulos`, `empresa_modulos`, `usuario_modulos` y
sus propias funciones RLS (`empresa_id_actual`, `puede_acceder_empresa`). No hay
un catálogo central compartido.

`distribuidorajmerp` es el schema del ERP de Distribuidora JM y es el origen del
clon. Se eligió ese y no `instemaq` (el abuelo de los dos) porque la lógica de
camiones, repartos, stock por vehículo y rendiciones que necesita Amasso ya está
aplicada ahí: clonar `instemaq` obligaría a volver a correr las ~40 migraciones
que `supabase/distribuidorajm/` fue acumulando.

Por eso el clon estructural completo alcanza para la independencia total:
`amasso` queda con su propia tabla de empresas y de usuarios, sin compartir nada
con `distribuidorajmerp`.

### Garantías de aislamiento

- El 01 solo hace `CREATE` dentro de `amasso`. Al schema origen únicamente lo
  lee; a `public`, `auth` y `storage` no los toca.
- Toda referencia interna `distribuidorajmerp.x` se reescribe a `amasso.x`: FKs,
  triggers, policies RLS, vistas, defaults y el `search_path` de las funciones
  `SECURITY DEFINER`. El ERP nuevo no queda colgado del viejo.
- Las FKs a `auth.users` se mantienen: es la tabla de Supabase, compartida por
  diseño (un solo GoTrue para toda la instancia).
- El 01 aborta si `amasso` ya existe: no pisa nada.
- Corre en una sola transacción.

El cuerpo del 01, del 02 y del 04 es **byte por byte el mismo** que se usó para
crear `distribuidorajmerp` a partir de `instemaq` (solo cambian los dos nombres
de schema y los comentarios). Ese juego de scripts se probó de punta a punta
contra un PostgreSQL 16 real, sobre un schema origen con tablas, secuencias,
FKs, índices parciales, triggers, RLS con policies que llaman funciones del
schema, vistas encadenadas, vista materializada, funciones `SECURITY DEFINER`
con `search_path` y publicación `supabase_realtime`. El 04 cerró con todos los
conteos de objetos iguales entre origen y destino, **0 fugas** y **0 filas** en
las tablas de negocio.

### Después del 01

La exposición del schema en PostgREST **la hacés vos** (queda fuera de estos
scripts, como pediste): Supabase → Settings → API → *Exposed schemas*, agregar
`amasso` a la lista y recargar. Los scripts ya emiten
`pg_notify('pgrst', 'reload schema')`.

Hasta que `amasso` esté expuesto, el ERP no puede leer nada: PostgREST responde
`PGRST106` con la lista de schemas que sí están habilitados.

---

## 2 · Módulos habilitados

El menú se arma con `empresa_modulos ∩ usuario_modulos`. El script 03 deja
activos exactamente estos 18, y **desactiva cualquier otro**:

`agenda`, `clientes`, `cobranzas`, `comisiones`, `compras`, `configuracion`,
`dashboard`, `gastos`, `gerencia`, `gestion-clientes`, `guardias`, `inventario`,
`notas_credito`, `pagos`, `reportes`, `tableros`, `usuarios`, `ventas`.

Equivalencias entre lo que pediste y el slug que el código evalúa:

| Pedido | Slug | Ruta |
|---|---|---|
| RRHH | `usuarios` | `/usuarios` |
| Ventas | `ventas` (en el menú figura **Caja**) | `/ventas` |
| Notas de crédito | `notas_credito` (guion **bajo**) | `/notas-credito` |
| Gestión Clientes | `gestion-clientes` (guion **medio**) | `/gestion-clientes` |
| Agenda | `agenda` | `/dashboard/agenda` |
| Gerencia | `gerencia` | `/dashboard/gerencia` |
| Guardias | `guardias` | `/dashboard/guardias` |
| Tableros | `tableros` | `/dashboard/tableros` |

**Movimientos** no es un módulo propio: es la vista hija de Inventario
(`/inventario/movimientos`), y entra con `inventario`.

### Dos cosas que hubo que arreglar para que la lista funcione

1. **`guardias` y `tableros` no existían en el catálogo heredado.** El schema
   origen tiene 35 filas en `modulos` y ninguna de las dos. El script 03 las da
   de alta con el slug exacto que evalúa el código. Sin eso, los dos módulos se
   habrían omitido en silencio.

2. **`tableros` es un módulo RESTRINGIDO**
   (`src/lib/modulos/modulos-restringidos.ts`): habilitarlo para la empresa no
   alcanza, el resolver lo esconde a todo el mundo —incluidos los
   administradores— salvo que haya una fila explícita en `usuario_modulos`. El
   script 03 se la crea al admin. Es la única fila de `usuario_modulos` que
   carga: para los otros 17 el rol `admin` ya alcanza, y cargarlas todas
   congelaría el menú de cualquier usuario no-admin en la lista de hoy.

   Además, `/dashboard/tableros` **no tenía gate de ruta propio**: caía en el
   fallback `conversaciones` del final de `pathRequiresModuleSlug`, así que tener
   el módulo concedido no servía para entrar. Arreglado en
   `src/lib/modulos/route-slug-map.ts` (lo mismo para `/dashboard/chat-interno`).

### Lo que queda fuera

`sorteos`, `crm`, `marketing`, `marketing_ops`, `campanas`, `conversaciones` y el
resto del stack omnicanal, `proyectos` (y con él `/dashboard/produccion`),
`soporte`, `planes`, `chat_interno`, `etiquetas`, `cobros`, `presupuestos`,
`recepcion`, `recibos`, `remision`, `recetas`.

`contabilidad` también queda fuera, y no es un olvido: ese slug **no tiene
ninguna vista** en el código (no aparece ni en `Sidebar.tsx` ni en
`route-slug-map.ts`), así que habilitarlo no agregaría ninguna pantalla. Lo
contable que sí existe —plan de cuentas, asientos, estado contable— vive bajo
`configuracion`, que sí está habilitado.

> Ojo: si `empresa_modulos` quedara vacía para esta empresa, el ERP muestra
> **todos** los módulos por retrocompatibilidad
> (`src/lib/modulos/resolve-effective-modules.ts`). Las filas del script 03 son
> las que recortan el menú: no las borres.

---

## 3 · Variables de entorno (Coolify)

Se clonaron de la app `neura-erp-distribuidorajm` con
`scripts/coolify-clonar-env.mjs`, que ya viene apuntado a este ERP.

```bash
node scripts/coolify-clonar-env.mjs plan    --url http://181.30.26.61:8000 --token "<token>" --origen 3fctblvtpujy2mrqtxeooxrp --destino ihi0rqlifmazhdsa0ojspfls
node scripts/coolify-clonar-env.mjs aplicar --url http://181.30.26.61:8000 --token "<token>" --origen 3fctblvtpujy2mrqtxeooxrp --destino ihi0rqlifmazhdsa0ojspfls
```

### Cambian sí o sí

| Variable | Valor |
|---|---|
| `APP_DB_SCHEMA` | `amasso` |
| `NEURA_CLIENT_SCHEMA` | `amasso` |
| `NEURA_CLIENT_NAME` | `Amasso` |
| `NEXT_PUBLIC_APP_URL` | `http://amasso.neura.com.py` |

`APP_DB_SCHEMA` es la que el código lee de verdad
(`src/lib/supabase/schema.ts`). `NEURA_CLIENT_SCHEMA` y `NEURA_CLIENT_NAME` no
las lee nadie en el repo: son etiquetas de infraestructura, y se ponen bien para
que el panel no muestre el schema del otro cliente.

El repo trae `amasso` como fallback compilado de `APP_DB_SCHEMA`, así que incluso
sin la variable el ERP apunta al schema correcto. Igual se define explícita: el
fallback es una red de seguridad, no la configuración.

### Se copian tal cual (misma instancia de Supabase self-hosted)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `NODE_OPTIONS`.

El pool de Postgres no fija `search_path`: todas las consultas van calificadas
con `APP_DB_SCHEMA`, así que la misma cadena de conexión sirve para los dos ERP
sin mezclarlos.

### Empresa: hay que poner el id nuevo o no definirlas

`WHATSAPP_DEFAULT_EMPRESA_ID`, `YCLOUD_WEBHOOK_EMPRESA_ID`,
`CRM_WEBHOOK_EMPRESA_ID`, `META_MSG_EMPRESA_ID`, `CONTACT_CENTER_EMPRESA_IDS`,
`FACTURACION_MENSUAL_EMPRESA_IDS`.

Si se copian con el id viejo, este ERP escribe sobre la empresa del otro. Como
los módulos omnicanal y de campañas quedan fuera, lo más limpio es **no
definirlas**; si alguna hace falta, va
`26f2bd0a-3394-4256-a908-bf8784368fd5`. El script las omite al copiar y además
las borra del destino si quedaron heredadas.

### Secretos propios (se generan nuevos, no se reusan)

`CRON_SECRET`, `WEBHOOK_SECRET`, `SIFEN_SECRETS_KEY`, `BAILEYS_BRIDGE_SECRET`,
`RAFFLES_N8N_SECRET`, `QA_SORTEO_TICKET_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`META_MSG_VERIFY_TOKEN`.

`SIFEN_SECRETS_KEY` cifra las contraseñas de los certificados SIFEN. Si se
comparte con el otro ERP, cada uno puede descifrar los certificados del otro:
el script le genera una nueva.

### Facturación electrónica

`SET_APIKEY` es la apiKey del contribuyente para consultar RUC contra la SET
(`src/lib/set/consulta-ruc.ts`). **Se copió la de Distribuidora JM y hay que
cambiarla por la de Amasso**: es una credencial del contribuyente, no de la
instancia.

Lo mismo con el certificado SIFEN y el timbrado, que se cargan desde el ERP en
Configuración → Facturación electrónica, no por variable de entorno.

---

## 4 · Dominio

`amasso.neura.com.py` por HTTP en Coolify (Cloudflare termina el TLS). El FQDN
ya está puesto en la app y Coolify generó las labels de Traefik y Caddy para ese
host.

**Falta el registro DNS**: `amasso.neura.com.py` todavía no resuelve. La zona
`neura.com.py` está en Cloudflare (`sergi`/`rihana.ns.cloudflare.com`) y los
hermanos (`distribuidorajm`, `ferrecolor`) resuelven a IPs de Cloudflare
(`104.21.14.32` / `172.67.157.173`), o sea registro **proxied**. Hay que crear
`amasso` igual que ellos.

Ya quedaron apuntando ahí en el repo:

- `NEXT_PUBLIC_APP_URL` (fallback en `src/lib/cobranzas/cobro-pendiente-notificar.ts`)
- `capacitor.config.ts` (`appId: py.com.neura.amasso`, `server.url`,
  `allowNavigation`, `cleartext: true`)
- `tutorial-erp/scripts/capture-tutorial.mjs`

---

## 5 · Pendientes conocidos

- **Exposición del schema en PostgREST**: la hacés vos, como acordamos (ver §1).
- **Registro DNS** de `amasso.neura.com.py` en Cloudflare (ver §4).
- **"Use a build server"** quedó en `false`. La app de Distribuidora JM lo tiene
  en `true` (compila en `build-server-arg` y empuja la imagen a
  `registry.neura.internal:5000`). La API v1 de Coolify no expone ese flag, así
  que hay que activarlo a mano en Application → Advanced. El nombre de imagen de
  registry ya quedó puesto (`registry.neura.internal:5000/neura-erp-amasso`), así
  que al activarlo no falta nada más. Con el flag en `false` la app igual
  compila, pero en el server de la app y más lento.
- **Deploy**: la app se creó con `instant_deploy: false`. No se disparó ningún
  deploy todavía.
- **`SET_APIKEY`**: la copiada es de Distribuidora JM. Cambiarla por la de
  Amasso antes de consultar RUC.
- **Contacto del emisor en el XML de SIFEN**: `src/lib/sifen/emisor-contacto.ts`
  centraliza `dTelEmi` y `dEmailE`, que antes estaban duplicados en la factura y
  en la nota de crédito. Los valores que hay son los placeholders heredados
  (`021000000`, `facturacion@configurar-empresa.com.py`): hay que poner el
  teléfono y el correo reales antes de facturar en producción.
- **Proyectos nativos** (`android/`, `ios/`): `capacitor.config.ts` ya dice
  `py.com.neura.amasso`, pero los proyectos nativos no se regeneraron. Si se va a
  publicar una app, correr `npx cap sync` y revisar nombre y bundle id.
- **Recetas de producción**: el brief de Amasso pide un módulo de recetas que
  descuente materias primas por producción. No existe en el código — `recetas`
  es una fila muerta del catálogo, sin vistas ni tablas detrás — y no estaba en
  la lista de 18 módulos, así que no se incluyó. Es desarrollo nuevo.
- **Devoluciones**: el brief también las menciona. `distribuidorajmerp` trae
  repartos, stock por camión, rendiciones y cierre, pero la vista
  `/ventas/devoluciones` existe en el ERP de Ferrecolor y no en este. Si hace
  falta, se porta.
