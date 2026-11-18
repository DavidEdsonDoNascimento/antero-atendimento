// Linha crua de `sql.ts` → item de tela. Puro, testável com `node --test`.
// Só valores reconhecidos viram texto: ação, tipo de responsável, módulo ou
// estado desconhecidos (eventos futuros, G3) caem num texto genérico, nunca no
// valor cru do banco.
import type { OrganizationModule } from "../../lib/types/database";
// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { auditActionLabel, orgStatusLabel } from "../../lib/labels.ts";
import { MODULE_CATALOG } from "../organizations/modules.ts";
import { isAuditAction, isAuditActorKind } from "./catalog.ts";
import type { AuditEventSqlRow } from "./sql";
import type { AuditEventActor, AuditEventItem } from "./types";

export const UNKNOWN_ACTION_LABEL = "Operação administrativa";
export const MAINTENANCE_ACTOR_LABEL = "Manutenção — alteração direta no banco";
export const REMOVED_USER_LABEL = "Usuário removido";
export const UNNAMED_USER_LABEL = "Usuário sem nome";
export const UNKNOWN_ACTOR_LABEL = "Responsável não identificado";
export const DELETED_ORGANIZATION_LABEL = "Organização excluída";

const MODULE_STATE_LABEL: Record<string, string> = { true: "Habilitado", false: "Desabilitado" };

function moduleLabel(module: string | null): string | null {
  if (module === null) return null;
  return Object.hasOwn(MODULE_CATALOG, module) ? MODULE_CATALOG[module as OrganizationModule].label : "Módulo não identificado";
}

function stateChange(
  labels: Record<string, string>,
  from: string | null,
  to: string | null,
): { from: string; to: string } | null {
  if (from === null || to === null || !Object.hasOwn(labels, from) || !Object.hasOwn(labels, to)) return null;
  return { from: labels[from], to: labels[to] };
}

function actorOf(row: AuditEventSqlRow): AuditEventActor {
  if (row.actor_kind === "maintenance") {
    return { kind: "maintenance", label: MAINTENANCE_ACTOR_LABEL, removed: false };
  }
  const kind = isAuditActorKind(row.actor_kind) ? row.actor_kind : "other";
  if (row.actor_user_id === null) return { kind, label: UNKNOWN_ACTOR_LABEL, removed: false };
  if (!row.actor_exists) return { kind, label: REMOVED_USER_LABEL, removed: true };
  const name = row.actor_name?.trim();
  return { kind, label: name ? name : UNNAMED_USER_LABEL, removed: false };
}

export function mapAuditEventRow(row: AuditEventSqlRow): AuditEventItem {
  const known = isAuditAction(row.action);
  const isModule = row.action === "module.enabled" || row.action === "module.disabled";
  const isStatus = row.action === "organization.suspended" || row.action === "organization.reactivated";
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    title: known ? auditActionLabel[row.action as keyof typeof auditActionLabel] : UNKNOWN_ACTION_LABEL,
    known,
    module: isModule ? moduleLabel(row.module) : null,
    change: isStatus
      ? stateChange(orgStatusLabel, row.from_state, row.to_state)
      : isModule
        ? stateChange(MODULE_STATE_LABEL, row.from_state, row.to_state)
        : null,
    organization: {
      id: row.organization_id,
      name: row.organization_exists ? row.organization_name : null,
      shortId: row.organization_id.slice(0, 8),
    },
    actor: actorOf(row),
  };
}
