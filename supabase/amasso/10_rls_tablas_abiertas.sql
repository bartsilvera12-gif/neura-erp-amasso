-- ============================================================================
-- 10_rls_tablas_abiertas.sql — cierra 7 tablas que la API pública dejaba
-- leer y ESCRIBIR con la anon key (la que viaja en el navegador).
--
-- Encontradas el 8-oct-2026: RLS apagado + grants completos a `anon`. Entre
-- ellas `bancos` (números de cuenta y titulares) y `usuario_permisos` (con
-- escritura abierta, cualquiera podía darse permisos).
--
-- Es seguro para el ERP: estas 7 tablas solo las lee el servidor, por la
-- conexión directa o la service role, que no pasan por RLS. Activar RLS sin
-- policies corta solo el acceso por la API pública, igual que ya están
-- `camiones`, `repartos` o `recetas`.
--
-- NO incluye `usuario_notificaciones`: la campanita la escucha en tiempo real
-- desde el navegador y Realtime sí respeta RLS. Necesita su propia policy
-- (cada usuario ve las suyas); va aparte.
--
-- Solo toca el schema `amasso`. Se puede correr más de una vez.
-- ============================================================================

ALTER TABLE amasso.bancos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.cobranza_promesas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.cobros_pendientes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.orden_compra_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.recepcion_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.recepciones         ENABLE ROW LEVEL SECURITY;
ALTER TABLE amasso.usuario_permisos    ENABLE ROW LEVEL SECURITY;

-- Verificación: tiene que quedar una sola tabla, usuario_notificaciones.
SELECT c.relname AS tabla_sin_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'amasso' AND c.relkind = 'r' AND NOT c.relrowsecurity
 ORDER BY 1;
