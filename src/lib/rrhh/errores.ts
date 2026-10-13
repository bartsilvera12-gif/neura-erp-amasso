/** Error de RRHH con mensaje para mostrar y código HTTP. */
export class AsistenciaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
