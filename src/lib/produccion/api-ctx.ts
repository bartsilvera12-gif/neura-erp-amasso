import { NextRequest, NextResponse } from "next/server";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { InsumoInsuficienteError, ProduccionError } from "./crear-produccion-pg";
import { MermaError } from "./mermas-pg";

export async function ctxProduccion(request: NextRequest) {
  const auth = await getAuthWithRol(request);
  if (!auth) return { error: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) } as const;
  const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
  return {
    schema,
    empresaId: auth.empresa_id,
    usuarioId: auth.user?.id ?? null,
    usuarioNombre: auth.nombre ?? auth.user?.email ?? null,
  } as const;
}

export function errorProduccion(err: unknown, donde: string) {
  if (err instanceof InsumoInsuficienteError) {
    return NextResponse.json(
      { ...errorResponse("Falta materia prima en el depósito: requiere confirmación."), faltantes: err.faltantes },
      { status: 409 }
    );
  }
  if (err instanceof ProduccionError || err instanceof MermaError) {
    return NextResponse.json(errorResponse(err.message), { status: err.status });
  }
  const e = err as { code?: string; message?: string };
  if (e?.code === "42P01" || e?.code === "42703") {
    return NextResponse.json(
      errorResponse("Faltan columnas o tablas de producción (script supabase/amasso/11_requerimientos_produccion.sql)."),
      { status: 500 }
    );
  }
  console.error(`[produccion] ${donde}:`, e?.message ?? err);
  return NextResponse.json(errorResponse(e?.message ?? "Error inesperado."), { status: 500 });
}
