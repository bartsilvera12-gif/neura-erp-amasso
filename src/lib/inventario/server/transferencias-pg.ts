import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Transferencias entre depósitos (Fábrica → Punto de venta, y al revés).
 *
 * Mueven stock entre ubicaciones sin tocar el total de la empresa: la
 * mercadería no entró ni salió, cambió de lugar. Por eso `productos.stock_actual`
 * no se toca y en `inventario_stock_ubicacion` se resta en el origen y se suma
 * en el destino, todo en una transacción con las filas bloqueadas.
 *
 * Quedan dos movimientos con origen `transferencia` (SALIDA en el origen,
 * ENTRADA en el destino) y la misma referencia TRF-…, para que el historial
 * de cada depósito cuente qué pasó. Por ahora no requieren confirmación de
 * quien recibe (requerimiento de Amasso).
 */

export class TransferenciaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type TransferenciaItem = { producto_id: string; cantidad: number };

export type TransferenciaInput = {
  origenId: string;
  destinoId: string;
  items: TransferenciaItem[];
  observacion?: string | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
};

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new TransferenciaError("No hay conexión directa a Postgres.", 500);
  return p;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function transferirStock(
  schemaRaw: string,
  empresaId: string,
  d: TransferenciaInput
): Promise<{ referencia: string; items: number }> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");
  const tSU = quoteSchemaTable(schema, "inventario_stock_ubicacion");
  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tSUcorto = tSU.split(".").pop();

  if (!d.origenId || !d.destinoId) throw new TransferenciaError("Elegí el depósito de origen y el de destino.");
  if (d.origenId === d.destinoId) throw new TransferenciaError("El origen y el destino tienen que ser distintos.");

  // Una línea por producto: dos renglones del mismo producto se suman.
  const porProducto = new Map<string, number>();
  for (const it of d.items ?? []) {
    const c = Number(it.cantidad);
    if (!it.producto_id || !Number.isFinite(c) || c <= 0) {
      throw new TransferenciaError("Cada línea necesita un producto y una cantidad mayor a 0.");
    }
    porProducto.set(it.producto_id, r6((porProducto.get(it.producto_id) ?? 0) + c));
  }
  if (porProducto.size === 0) throw new TransferenciaError("Agregá al menos un producto.");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const ubis = await client.query<{ id: string; nombre: string; tipo: string; activo: boolean }>(
      `SELECT id, nombre, tipo, activo FROM ${tU} WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
      [empresaId, [d.origenId, d.destinoId]]
    );
    const origen = ubis.rows.find((u) => u.id === d.origenId);
    const destino = ubis.rows.find((u) => u.id === d.destinoId);
    if (!origen || !destino) throw new TransferenciaError("Depósito no encontrado.", 404);
    if (!origen.activo || !destino.activo) throw new TransferenciaError("Uno de los depósitos está inactivo.");

    const ids = [...porProducto.keys()];
    const prods = await client.query<{ id: string; nombre: string; sku: string | null; costo_promedio: string }>(
      `SELECT id, nombre, sku, costo_promedio::text FROM ${tP}
        WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
      [empresaId, ids]
    );
    if (prods.rows.length !== ids.length) throw new TransferenciaError("Algún producto no existe en esta empresa.", 404);
    const prodById = new Map(prods.rows.map((p) => [p.id, p]));

    // Stock del origen, bloqueado mientras dura la transferencia.
    const enOrigen = await client.query<{ producto_id: string; stock_actual: string }>(
      `SELECT producto_id, stock_actual::text FROM ${tSU}
        WHERE empresa_id = $1::uuid AND ubicacion_id = $2::uuid AND producto_id = ANY($3::uuid[])
        FOR UPDATE`,
      [empresaId, d.origenId, ids]
    );
    const hay = new Map(enOrigen.rows.map((r) => [r.producto_id, Number(r.stock_actual)]));
    for (const [pid, cant] of porProducto) {
      const disponible = hay.get(pid) ?? 0;
      if (disponible + 1e-9 < cant) {
        throw new TransferenciaError(
          `En ${origen.nombre} hay ${disponible} de "${prodById.get(pid)!.nombre}" y querés transferir ${cant}.`,
          409
        );
      }
    }

    const sec = await client.query<{ n: string }>(
      `SELECT count(DISTINCT referencia)::text AS n FROM ${tM}
        WHERE empresa_id = $1::uuid AND origen = 'transferencia'`,
      [empresaId]
    );
    const referencia = `TRF-${String(Number(sec.rows[0]?.n ?? 0) + 1).padStart(6, "0")}`;
    const nota = d.observacion?.trim() ? ` · ${d.observacion.trim().slice(0, 200)}` : "";

    for (const [pid, cant] of porProducto) {
      const p = prodById.get(pid)!;
      for (const [ubiId, signo, tipo, otro] of [
        [d.origenId, -1, "SALIDA", destino.nombre],
        [d.destinoId, 1, "ENTRADA", origen.nombre],
      ] as const) {
        await client.query(
          `INSERT INTO ${tSU} (empresa_id, producto_id, ubicacion_id, stock_actual)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric)
           ON CONFLICT (empresa_id, producto_id, ubicacion_id)
             DO UPDATE SET stock_actual = ${tSUcorto}.stock_actual + EXCLUDED.stock_actual, updated_at = now()`,
          [empresaId, pid, ubiId, signo * cant]
        );
        await client.query(
          `INSERT INTO ${tM} (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
             costo_unitario, origen, referencia, fecha, created_by, usuario_nombre, ubicacion_id, motivo)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7::numeric, 'transferencia', $8, now(),
                   $9::uuid, $10, $11::uuid, $12)`,
          [
            empresaId, pid, p.nombre, p.sku ?? "", tipo, cant, Number(p.costo_promedio) || 0, referencia,
            d.usuarioId, d.usuarioNombre, ubiId,
            `${tipo === "SALIDA" ? "Hacia" : "Desde"} ${otro}${nota}`,
          ]
        );
      }
    }

    await client.query("COMMIT");
    return { referencia, items: porProducto.size };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export type TransferenciaResumen = {
  referencia: string;
  fecha: string;
  origen: string | null;
  destino: string | null;
  usuario: string | null;
  lineas: { producto: string; cantidad: number }[];
};

/** Últimas transferencias, agrupadas por referencia. */
export async function listarTransferencias(
  schemaRaw: string,
  empresaId: string,
  limite = 30
): Promise<TransferenciaResumen[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tU = quoteSchemaTable(schema, "inventario_ubicaciones");
  const { rows } = await pool().query<{
    referencia: string; fecha: string; tipo: string; ubicacion: string | null;
    usuario_nombre: string | null; producto_nombre: string; cantidad: string;
  }>(
    `WITH refs AS (
       SELECT referencia, max(fecha) AS f FROM ${tM}
        WHERE empresa_id = $1::uuid AND origen = 'transferencia'
        GROUP BY referencia ORDER BY f DESC LIMIT $2
     )
     SELECT m.referencia, m.fecha::text, m.tipo, u.nombre AS ubicacion, m.usuario_nombre,
            m.producto_nombre, m.cantidad::text
       FROM ${tM} m
       JOIN refs r ON r.referencia = m.referencia
       LEFT JOIN ${tU} u ON u.id = m.ubicacion_id
      WHERE m.empresa_id = $1::uuid AND m.origen = 'transferencia'
      ORDER BY r.f DESC, m.producto_nombre`,
    [empresaId, limite]
  );
  const out = new Map<string, TransferenciaResumen>();
  for (const r of rows) {
    const t = out.get(r.referencia) ?? {
      referencia: r.referencia, fecha: r.fecha, origen: null, destino: null, usuario: r.usuario_nombre, lineas: [],
    };
    if (r.tipo === "SALIDA") {
      t.origen = r.ubicacion;
      t.lineas.push({ producto: r.producto_nombre, cantidad: Number(r.cantidad) });
    } else {
      t.destino = r.ubicacion;
    }
    out.set(r.referencia, t);
  }
  return [...out.values()];
}
