import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** PIN de marcación: se guarda como hash scrypt con sal, nunca en claro. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verificarPin(pin: string, guardado: string): boolean {
  const [alg, salt, hash] = guardado.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const calc = scryptSync(pin, salt, 32);
  const esperado = Buffer.from(hash, "hex");
  return esperado.length === calc.length && timingSafeEqual(esperado, calc);
}
