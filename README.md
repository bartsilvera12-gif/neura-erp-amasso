# Neura ERP · Amasso

ERP de Amasso (panificados): copia independiente de
[`neura-erp-distribuidorajm`](https://github.com/bartsilvera12-gif/neura-erp-distribuidorajm),
con su propio schema Postgres (`amasso`), su propia empresa y su propio login.
Mismo código, datos totalmente separados. No comparte historial git con el ERP
de origen.

- **Puesta en marcha (SQL, variables de entorno, dominio):** [`DEPLOY_AMASSO.md`](DEPLOY_AMASSO.md)
- **Scripts SQL:** [`supabase/amasso/`](supabase/amasso/)
- **Documentación funcional heredada:** [`DOCUMENTACION_TECNICA.md`](DOCUMENTACION_TECNICA.md), [`docs/`](docs/)

| | |
|---|---|
| Stack | Next.js (App Router) · Supabase self-hosted · Coolify |
| Schema de datos | `amasso` (`APP_DB_SCHEMA`) |
| URL | `http://amasso.neura.com.py` (HTTP: el TLS lo termina Cloudflare) |
| Empresa id | `26f2bd0a-3394-4256-a908-bf8784368fd5` |
| Admin | `admin@amasso.com` (rol `admin`) |

## Desarrollo

```bash
npm install
npm run dev     # http://localhost:3000
npm run lint
```

Requiere un `.env.local` con al menos `APP_DB_SCHEMA=amasso`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y
`SUPABASE_SERVICE_ROLE_KEY`. La lista completa está en el documento de
puesta en marcha.

## Módulos habilitados

Agenda · Clientes · Cobranzas · Comisiones · Compras · Configuración ·
Dashboard · Gastos · Gerencia · Gestión Clientes · Guardias · Inventario
(incluye Movimientos) · Notas de crédito · Pagos · Recetas · Reportes · RRHH ·
Tableros · Ventas

**Recetas** es el recetario con costeo y fabricación: se portó del ERP de La
Mexicana y descuenta materia prima al producir. Detalle en
[`DEPLOY_AMASSO.md`](DEPLOY_AMASSO.md) §2.1.

El menú sale de `empresa_modulos`, no del código: se amplía o se recorta desde
la base, sin tocar el repo. Qué quedó fuera y por qué está en
[`DEPLOY_AMASSO.md`](DEPLOY_AMASSO.md).
