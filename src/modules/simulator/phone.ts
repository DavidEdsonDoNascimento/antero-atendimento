// Puro (sem I/O), testável com `node --test`.

const E164 = /^\+[1-9][0-9]{1,14}$/;

/**
 * Telefone digitado no simulador → E.164 (a forma que a ingestão e
 * `contacts_phone_number_format` exigem), ou `null` se não der. Aceita espaços,
 * parênteses, hífens e pontos, e o prefixo internacional `00`. Não adivinha o
 * país: sem `+`/`00` é recusado.
 */
export function normalizeSimulatorPhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, "");
  const withPlus = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  return E164.test(withPlus) ? withPlus : null;
}

/** Prefixo dos ids externos das mensagens recebidas pelo simulador. */
export const SIMULATED_INBOUND_PREFIX = "sim-in-";
const SIMULATED_INBOUND_ID = /^sim-in-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Um id externo gerado pelo simulador (reenviar com ele simula a reentrega da Meta). */
export function isSimulatedInboundId(value: unknown): value is string {
  return typeof value === "string" && SIMULATED_INBOUND_ID.test(value);
}
