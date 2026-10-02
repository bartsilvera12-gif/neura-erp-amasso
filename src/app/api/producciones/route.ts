import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import {
  fetchDataSchemaForEmpresaId,
  createServiceRoleClientWithDbSchema,
} from "@/lib/supabase/empresa-data-schema";
import {
  crearProduccionPg,
  previewProduccion,
  InsumoInsuficienteError,
  ProduccionError,
} from "@/lib/produccion/crear-produccion-pg";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/** GET /api/producciones — listado de producciones de la empresa. */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const sb = createServiceRoleClientWithDbSchema(schema);
    const { data, error } = await sb
      .from("producciones")
      .select(
        "id, receta_id, producto_id, producto_nombre, cantidad_fabricada, rendimiento_cantidad, unidad_rendimiento, costo_total, costo_unitario, fecha, usuario_nombre, observaciones"
      )
      .eq("empresa_id", auth.empresa_id)
      .order("fecha", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return NextResponse.json(successResponse({ producciones: data ?? [] }));
  } catch (err) {
    console.error("[/api/producciones GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las producciones."), {
      status: 500,
    });
  }
}

/**
 * POST /api/producciones — registra una fabricación desde una receta.
 *
 * Body: { receta_id, cantidad, ubicacion_id?, observaciones?, permitir_sin_stock?, preview? }
 *
 * Con `preview === true` solo devuelve el cálculo (insumos requeridos, faltantes,
 * costo y en qué ubicación se fabricaría) sin escribir nada.
 *
 * Fabricar NO está restringido por rol: es una operación de planta. Lo que sí
 * está restringido es editar el recetario (ver `require-edicion-recetas.ts`).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const recetaId = body.receta_id ? String(body.receta_id) : "";
    if (!recetaId) {
      return NextResponse.json(errorResponse("receta_id es obligatorio."), { status: 400 });
    }
    const cantidad = Number(body.cantidad);
    if (!(cantidad > 0)) {
      return NextResponse.json(errorResponse("La cantidad a fabricar debe ser mayor a cero."), {
        status: 400,
      });
    }
    const observaciones =
      body.observaciones === null || body.observaciones === undefined
        ? null
        : String(body.observaciones).slice(0, 4000);

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);

    const baseParams = {
      schema,
      empresaId: auth.empresa_id,
      recetaId,
      cantidadFabricar: cantidad,
      ubicacionId: body.ubicacion_id ? String(body.ubicacion_id) : null,
      observaciones,
      permitirSinStock: body.permitir_sin_stock === true,
      usuarioId: auth.user?.id ?? null,
      usuarioNombre: auth.nombre ?? null,
    };

    if (body.preview === true) {
      const preview = await previewProduccion(baseParams);
      return NextResponse.json(successResponse({ preview }));
    }

    const result = await crearProduccionPg(baseParams);
    return NextResponse.json(successResponse({ produccion: result }));
  } catch (err) {
    // Falta de materia prima sin autorizar: 409 con el detalle para que la UI
    // muestre el modal de confirmación y reintente con permitir_sin_stock.
    if (err instanceof InsumoInsuficienteError) {
      return NextResponse.json(
        {
          ...errorResponse("Materia prima insuficiente: requiere confirmación."),
          faltantes: err.faltantes,
        },
        { status: 409 }
      );
    }
    if (err instanceof ProduccionError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "Error al registrar la producción.";
    console.error("[/api/producciones POST]", msg);
    return NextResponse.json(errorResponse("No se pudo registrar la producción."), { status: 500 });
  }
}
