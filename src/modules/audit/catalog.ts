// Catálogo das operações auditadas, puro (sem I/O), usado pelo filtro, pelos
// mapeadores e pelos testes. `tests/db/audit-history.test.ts` confere que ele
// tem os mesmos valores do CHECK `audit_events_action` (0013).
import type { AuditAction, AuditActorKind } from "../../lib/types/database";

export const AUDIT_ACTIONS = [
  "organization.suspended",
  "organization.reactivated",
  "module.enabled",
  "module.disabled",
] as const satisfies readonly AuditAction[];

export const AUDIT_ACTOR_KINDS = ["platform_admin", "maintenance"] as const satisfies readonly AuditActorKind[];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function isAuditActorKind(value: string): value is AuditActorKind {
  return (AUDIT_ACTOR_KINDS as readonly string[]).includes(value);
}
