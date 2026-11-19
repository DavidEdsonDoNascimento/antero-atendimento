import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Lógica pura (sem I/O) — sem `import "server-only"`, testável com `node --test`.

/** Cabeçalho da Meta: `sha256=<HMAC-SHA256 hexadecimal do corpo bruto, com o App Secret>`. */
export const SIGNATURE_HEADER = "x-hub-signature-256";

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

export type SignatureCheck = { valid: true } | { valid: false; reason: "missing" | "malformed" | "mismatch" };

/**
 * Confere a assinatura sobre os BYTES recebidos, antes de qualquer parse (um
 * JSON reformatado teria outra assinatura). Comparação em tempo constante.
 */
export function checkSignature(body: Uint8Array, header: string | null, appSecret: string): SignatureCheck {
  if (header === null || header.trim() === "") return { valid: false, reason: "missing" };
  const match = SIGNATURE.exec(header.trim());
  if (!match) return { valid: false, reason: "malformed" };
  const expected = createHmac("sha256", appSecret).update(body).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected)
    ? { valid: true }
    : { valid: false, reason: "mismatch" };
}

/** Assinatura que a Meta enviaria para `body` (testes e diagnóstico local). */
export function signatureFor(body: Uint8Array | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

/**
 * Igualdade de textos em tempo constante, inclusive com tamanhos diferentes
 * (compara os resumos sha256): para o verify token da verificação GET.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}
