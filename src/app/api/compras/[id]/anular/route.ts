import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { usuarioDelSchema } from "@/lib/repartos/server/repartos-pg";
import { getAsientoConDetalles, generarAsientoEnTx } from "@/lib/contabilidad/asientos-pg";

/**
 * POST /api/compras/[id]/anular — anula una compra y revierte lo que movió.
 *
 * Anular no es borrar: la compra queda con `estado = 'anulada'` y su número
 * sigue ocupado. Lo que se revierte:
 *
 *  · **Stock**, pero SOLO el que esta compra movió. Una compra nacida de una
 *    recepción no movió nada —la mercadería entró con la recepción, y el propio
 *    modal lo dice: "esta compra no vuelve a mover el stock"—, así que anularla
 *    no puede descontar nada. Si lo hiciera, el depósito quedaría en menos sin
 *    que haya salido nada. Se mira ítem por ítem: `recepcion_item_id` vacío y
 *    `afecta_inventario` en true.
 *  · **El asiento contable**, con un asiento inverso, igual que la anulación de
 *    un gasto. El original queda marcado `revertido`, no se borra.
 *  · **El movimiento de caja**, si la compra fue de contado: se marca anulado,
 *    la fila queda.
 *
 * Todo en una transacción: o se revierte entero o no se toca nada.
 *
 * Permiso: solo admin de empresa. Anular una compra mueve stock y libro de
 * compras, no es una corrección cualquiera.
 */

type RouteCtx = { params: Promise<{ id: string }> };

async function tablaExiste(
  client: { query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<{ t: string | null }> }> },
  schema: string,
  tabla: string
): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1)::text AS t`, [`${schema}.${tabla}`]);
  return Boolean(r.rows[0]?.t);
}

async function tieneColumna(
  client: { query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<{ c: string }> }> },
  schema: string,
  tabla: string,
  columna: string
): Promise<boolean> {
  const r = await client.query(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, tabla, columna]
  );
  return r.rows.length > 0;
}

export async function POST(request: NextRequest, { params }: RouteCtx) {
  const { id } = await params;
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!esRolAdminEmpresa(ctx.auth.rol)) {
      return NextResponse.json(
        errorResponse("Solo un administrador puede anular una compra."),
        { status: 403 }
      );
    }

    const empresaId = ctx.auth.empresa_id;
    const schema = assertAllowedChatDataSchema(await fetchDataSchemaForEmpresaId(empresaId));
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const motivo = body.motivo == null ? null : String(body.motivo).trim().slice(0, 500) || null;

    const pool = getChatPostgresPool();
    if (!pool) {
      return NextResponse.json(errorResponse("No hay conexión directa a Postgres."), { status: 500 });
    }

    const yo = await usuarioDelSchema({
      schema,
      empresaId,
      email: ctx.auth.user.email,
      catalogId: ctx.auth.usuarioCatalogId ?? null,
    });

    const tC = quoteSchemaTable(schema, "compras");
    const tCI = quoteSchemaTable(schema, "compra_items");
    const tP = quoteSchemaTable(schema, "productos");
    const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
    const tM = quoteSchemaTable(schema, "movimientos_inventario");

    const client = await pool.connect();
    let abierta = false;
    try {
      await client.query("BEGIN");
      abierta = true;

      const compraQ = await client.query<{
        numero_comprobante: string | null;
        estado: string | null;
        afecta_stock: boolean | null;
        asiento_contable_id: string | null;
        estado_contable: string | null;
      }>(
        `SELECT numero_comprobante, estado, afecta_stock, asiento_contable_id, estado_contable
           FROM ${tC} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
        [id, empresaId]
      );
      const compra = compraQ.rows[0];
      if (!compra) {
        await client.query("ROLLBACK");
        abierta = false;
        return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
      }
      if ((compra.estado ?? "") === "anulada") {
        await client.query("ROLLBACK");
        abierta = false;
        return NextResponse.json(errorResponse("Esa compra ya está anulada."), { status: 409 });
      }

      // ── Stock: solo lo que esta compra movió ────────────────────────────────
      // El SKU sale de `productos`: `compra_items` no lo guarda y
      // `movimientos_inventario.producto_sku` es NOT NULL.
      const itemsQ = await client.query<{
        producto_id: string | null;
        producto_nombre: string | null;
        sku: string | null;
        cantidad: string | number;
        costo_unitario: string | number | null;
        afecta_inventario: boolean | null;
        recepcion_item_id: string | null;
      }>(
        `SELECT ci.producto_id, ci.producto_nombre, p.sku, ci.cantidad, ci.costo_unitario,
                ci.afecta_inventario, ci.recepcion_item_id
           FROM ${tCI} ci
           LEFT JOIN ${tP} p ON p.id = ci.producto_id
          WHERE ci.compra_id = $1::uuid AND ci.empresa_id = $2::uuid`,
        [id, empresaId]
      );

      const hayStockUbi = await tablaExiste(client, schema, "inventario_stock_ubicacion");
      const hayMovs = await tablaExiste(client, schema, "movimientos_inventario");
      const movTieneUbicacion =
        hayMovs && (await tieneColumna(client, schema, "movimientos_inventario", "ubicacion_id"));

      let revertidos = 0;
      if (compra.afecta_stock !== false) {
        for (const it of itemsQ.rows) {
          const cantidad = Number(it.cantidad);
          if (!it.producto_id || !(cantidad > 0)) continue;
          // La mercadería de una compra facturada contra una recepción entró con
          // la recepción, no con esta compra.
          if (it.recepcion_item_id) continue;
          if (it.afecta_inventario === false) continue;

          await client.query(
            `UPDATE ${tP}
                SET stock_actual = GREATEST(0, COALESCE(stock_actual, 0) - $1::numeric),
                    updated_at = now()
              WHERE id = $2::uuid AND empresa_id = $3::uuid`,
            [cantidad, it.producto_id, empresaId]
          );

          // De qué ubicación salió: la que registró el movimiento de la compra.
          let ubicacionId: string | null = null;
          if (hayMovs && movTieneUbicacion) {
            const uq = await client.query<{ ubicacion_id: string | null }>(
              `SELECT ubicacion_id FROM ${tM}
                WHERE empresa_id = $1::uuid AND producto_id = $2::uuid
                  AND documento_tipo = 'compra' AND documento_id = $3::uuid
                ORDER BY fecha DESC LIMIT 1`,
              [empresaId, it.producto_id, id]
            );
            ubicacionId = uq.rows[0]?.ubicacion_id ?? null;
          }

          if (ubicacionId && hayStockUbi) {
            await client.query(
              `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 0)
               ON CONFLICT (empresa_id, producto_id, ubicacion_id)
               DO UPDATE SET stock_actual = GREATEST(0, ${tSU.split(".").pop()}.stock_actual - $4::numeric),
                             updated_at = now()`,
              [empresaId, it.producto_id, ubicacionId, cantidad]
            );
          }

          if (hayMovs) {
            await client.query(
              `INSERT INTO ${tM} (
                 empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
                 costo_unitario, origen, referencia, fecha, created_by, usuario_nombre
                 ${movTieneUbicacion ? ", ubicacion_id" : ""}
               ) VALUES (
                 $1::uuid, $2::uuid, $3, $4, 'SALIDA', $5::numeric,
                 $6::numeric, 'anulacion', $7, now(), $8::uuid, $9
                 ${movTieneUbicacion ? ", $10::uuid" : ""}
               )`,
              [
                empresaId,
                it.producto_id,
                it.producto_nombre ?? "",
                it.sku ?? "",
                cantidad,
                Number(it.costo_unitario) || 0,
                `Anulación compra ${compra.numero_comprobante ?? ""}`.trim(),
                yo?.id ?? null,
                ctx.auth.nombre ?? null,
                ...(movTieneUbicacion ? [ubicacionId] : []),
              ]
            );
          }
          revertidos += 1;
        }
      }

      // ── Contabilidad: asiento inverso, el original queda marcado ────────────
      let estadoContable: string | null = null;
      if (compra.estado_contable === "contabilizado" && compra.asiento_contable_id) {
        const orig = await getAsientoConDetalles(client, schema, empresaId, compra.asiento_contable_id);
        if (orig) {
          const rev = await generarAsientoEnTx(client, schema, empresaId, {
            origen_tipo: "reversion",
            origen_id: id,
            evento_origen: "reversion",
            fecha_contable: String(orig.cabecera.fecha_contable).slice(0, 10),
            glosa: `Reversión Compra ${compra.numero_comprobante ?? ""}`.trim(),
            moneda: orig.cabecera.moneda,
            tipo_cambio: Number(orig.cabecera.tipo_cambio) || 1,
            lineas: orig.detalles.map((d) => ({
              cuenta_contable_id: d.cuenta_contable_id,
              proveedor_id: d.proveedor_id ?? null,
              descripcion: `Reversión: ${d.descripcion ?? ""}`.trim(),
              debe: Number(d.haber) || 0,
              haber: Number(d.debe) || 0,
              documento_tipo: d.documento_tipo ?? null,
              documento_id: d.documento_id ?? null,
            })),
            createdBy: yo?.id ?? null,
            asiento_original_id: compra.asiento_contable_id,
          });
          await client.query(
            `UPDATE ${quoteSchemaTable(schema, "asientos_contables")}
                SET estado = 'revertido', asiento_reversion_id = $2::uuid
              WHERE id = $1::uuid`,
            [compra.asiento_contable_id, rev.id]
          );
          estadoContable = "revertido";
        }
      }

      // ── Caja: el egreso deja de contar, la fila queda ───────────────────────
      if (await tablaExiste(client, schema, "caja_movimientos")) {
        if (await tieneColumna(client, schema, "caja_movimientos", "compra_id")) {
          await client.query(
            `UPDATE ${quoteSchemaTable(schema, "caja_movimientos")}
                SET anulado_at = now()
              WHERE compra_id = $1::uuid AND empresa_id = $2::uuid AND anulado_at IS NULL`,
            [id, empresaId]
          );
        }
      }

      const sets = ["estado = 'anulada'", "anulada_at = now()"];
      const vals: unknown[] = [id, empresaId];
      if (await tieneColumna(client, schema, "compras", "anulada_por")) {
        vals.push(yo?.id ?? null);
        sets.push(`anulada_por = $${vals.length}::uuid`);
      }
      if (motivo && (await tieneColumna(client, schema, "compras", "anulada_motivo"))) {
        vals.push(motivo);
        sets.push(`anulada_motivo = $${vals.length}`);
      }
      if (estadoContable) {
        vals.push(estadoContable);
        sets.push(`estado_contable = $${vals.length}`);
      }
      await client.query(
        `UPDATE ${tC} SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $1::uuid AND empresa_id = $2::uuid`,
        vals
      );

      await client.query("COMMIT");
      abierta = false;

      return NextResponse.json(
        successResponse({
          compra_id: id,
          estado: "anulada",
          items_revertidos: revertidos,
          contabilidad: estadoContable,
        })
      );
    } catch (err) {
      if (abierta) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* la conexión ya se cayó: el servidor aborta la transacción igual */
        }
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    // El motivo va en la respuesta y no solo al log: un "no se pudo" a secas
    // obliga a entrar al servidor para saber qué pasó.
    const o = (err ?? {}) as { message?: unknown; detail?: unknown; code?: unknown };
    const partes = [
      typeof o.message === "string" ? o.message : "",
      typeof o.detail === "string" ? o.detail : "",
    ].filter(Boolean);
    const msg = partes.join(" · ") || String(err ?? "");
    console.error("[/api/compras/[id]/anular]", { id, msg, code: o.code });
    return NextResponse.json(
      errorResponse(msg ? `No se pudo anular la compra: ${msg}` : "No se pudo anular la compra."),
      { status: 500 }
    );
  }
}
