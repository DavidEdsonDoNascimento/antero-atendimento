// Log estruturado de recusas administrativas (G2B). Recusas não vão para
// `audit_events`: o ROLLBACK da operação recusada levaria o registro junto, e a
// tabela guarda só alterações efetivadas. Uma linha JSON por recusa, no stdout
// do servidor (logs do contêiner), para investigação.
//
// Nada que venha do navegador sai daqui sem filtro: ação e motivo são listas
// fechadas, ids só se forem UUID, SQLSTATE só no formato de 5 caracteres. Sem
// e-mail, nome, mensagem do banco, conteúdo de cliente ou credencial.
// Sem `server-only` de propósito: puro, para `node --test`.
import { randomUUID } from "node:crypto";

export type SecurityAction = "admin.access" | "organization.set_status" | "organization.set_module";
export type SecurityReason = "not_platform_admin" | "access_denied" | "invalid_input" | "organization_not_found";

export type SecurityEvent = {
  action: SecurityAction;
  reason: SecurityReason;
  /** Usuário autenticado (da sessão validada), quando houver. */
  userId?: string | null;
  /** Organização envolvida, como veio da requisição: só sai se for um UUID. */
  organizationId?: unknown;
  sqlState?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const uuidOrNull = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;

/** A linha de log (objeto), já filtrada. `id` correlaciona a recusa com o relato do usuário. */
export function securityLogEntry(event: SecurityEvent, now: Date = new Date(), id: string = randomUUID()) {
  const entry: Record<string, string | null> = {
    type: "security",
    event: "admin.denied",
    id,
    at: now.toISOString(),
    action: event.action,
    reason: event.reason,
    userId: uuidOrNull(event.userId),
  };
  if (event.organizationId !== undefined) {
    entry.organizationId = uuidOrNull(event.organizationId) ?? "invalid";
  }
  if (event.sqlState !== undefined && SQLSTATE.test(event.sqlState)) entry.sqlState = event.sqlState;
  return entry;
}

/** Registra a recusa no log do servidor e devolve o id do registro. */
export function logSecurityEvent(event: SecurityEvent): string {
  const entry = securityLogEntry(event);
  console.warn(JSON.stringify(entry));
  return entry.id as string;
}
