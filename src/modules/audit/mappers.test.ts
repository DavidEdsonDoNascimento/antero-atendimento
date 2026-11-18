import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DELETED_ORGANIZATION_LABEL,
  MAINTENANCE_ACTOR_LABEL,
  REMOVED_USER_LABEL,
  UNKNOWN_ACTION_LABEL,
  UNKNOWN_ACTOR_LABEL,
  UNNAMED_USER_LABEL,
  mapAuditEventRow,
} from "./mappers.ts";
import type { AuditEventSqlRow } from "./sql.ts";

const ORG = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";
const USER = "0b6c3f10-2d4e-4f5a-9b8c-abcdefabcdef";

function row(overrides: Partial<AuditEventSqlRow> = {}): AuditEventSqlRow {
  return {
    id: "10",
    occurred_at: "2026-11-18T13:00:00.123456+00:00",
    organization_id: ORG,
    action: "organization.suspended",
    actor_kind: "platform_admin",
    actor_user_id: USER,
    actor_exists: true,
    actor_name: "Paula Plataforma",
    organization_exists: true,
    organization_name: "Oficina Boreal",
    module: null,
    from_state: "active",
    to_state: "inactive",
    ...overrides,
  };
}

test("as quatro operações em português, com de/para e módulo pelo catálogo", () => {
  assert.deepEqual(mapAuditEventRow(row()), {
    id: "10",
    occurredAt: "2026-11-18T13:00:00.123456+00:00",
    title: "Organização suspensa",
    known: true,
    module: null,
    change: { from: "Ativa", to: "Suspensa" },
    organization: { id: ORG, name: "Oficina Boreal", shortId: "6f1c2a4e" },
    actor: { kind: "platform_admin", label: "Paula Plataforma", removed: false },
  });
  const reactivated = mapAuditEventRow(row({ action: "organization.reactivated", from_state: "inactive", to_state: "active" }));
  assert.equal(reactivated.title, "Organização reativada");
  assert.deepEqual(reactivated.change, { from: "Suspensa", to: "Ativa" });

  const enabled = mapAuditEventRow(row({ action: "module.enabled", module: "contatos", from_state: "false", to_state: "true" }));
  assert.equal(enabled.title, "Módulo habilitado");
  assert.equal(enabled.module, "Contatos");
  assert.deepEqual(enabled.change, { from: "Desabilitado", to: "Habilitado" });

  const disabled = mapAuditEventRow(row({ action: "module.disabled", module: "automacoes", from_state: "true", to_state: "false" }));
  assert.equal(disabled.title, "Módulo desabilitado");
  assert.equal(disabled.module, "Automações");
  assert.deepEqual(disabled.change, { from: "Habilitado", to: "Desabilitado" });
});

test("responsável: nome aparado, sem nome, removido e manutenção (sem db_role)", () => {
  assert.equal(mapAuditEventRow(row({ actor_name: "  Paula  " })).actor.label, "Paula");
  for (const name of [null, "", "   "]) {
    assert.deepEqual(mapAuditEventRow(row({ actor_name: name })).actor, { kind: "platform_admin", label: UNNAMED_USER_LABEL, removed: false });
  }
  assert.deepEqual(mapAuditEventRow(row({ actor_exists: false, actor_name: null })).actor, {
    kind: "platform_admin",
    label: REMOVED_USER_LABEL,
    removed: true,
  });
  const maintenance = mapAuditEventRow(row({ actor_kind: "maintenance", actor_user_id: null, actor_exists: false, actor_name: null }));
  assert.deepEqual(maintenance.actor, { kind: "maintenance", label: MAINTENANCE_ACTOR_LABEL, removed: false });
  assert.equal(MAINTENANCE_ACTOR_LABEL, "Manutenção — alteração direta no banco");
  assert.equal(REMOVED_USER_LABEL, "Usuário removido");
  assert.equal(UNNAMED_USER_LABEL, "Usuário sem nome");
});

test("organização excluída: evento preservado com identificação curta", () => {
  const item = mapAuditEventRow(row({ organization_exists: false, organization_name: null }));
  assert.deepEqual(item.organization, { id: ORG, name: null, shortId: "6f1c2a4e" });
  assert.equal(DELETED_ORGANIZATION_LABEL, "Organização excluída");
});

test("operações, responsáveis, módulos e estados desconhecidos: texto genérico, nunca o valor cru", () => {
  const unknown = mapAuditEventRow(row({ action: "support.started", from_state: "x", to_state: "y" }));
  assert.equal(unknown.title, UNKNOWN_ACTION_LABEL);
  assert.equal(unknown.known, false);
  assert.equal(unknown.change, null);
  assert.equal(unknown.module, null);

  assert.deepEqual(mapAuditEventRow(row({ actor_kind: "support" })).actor, { kind: "other", label: "Paula Plataforma", removed: false });
  assert.deepEqual(mapAuditEventRow(row({ actor_kind: "system", actor_user_id: null })).actor, {
    kind: "other",
    label: UNKNOWN_ACTOR_LABEL,
    removed: false,
  });

  const strangeModule = mapAuditEventRow(row({ action: "module.enabled", module: "financeiro", from_state: "false", to_state: "true" }));
  assert.equal(strangeModule.module, "Módulo não identificado");
  assert.equal(mapAuditEventRow(row({ action: "module.enabled", module: "toString", from_state: "false", to_state: "true" })).module, "Módulo não identificado");
  assert.equal(mapAuditEventRow(row({ from_state: "active", to_state: "archived" })).change, null);
  assert.equal(mapAuditEventRow(row({ from_state: null, to_state: null })).change, null);
  assert.equal(mapAuditEventRow(row({ action: "module.enabled", module: "contatos", from_state: "constructor", to_state: "true" })).change, null);

  const serialized = JSON.stringify([unknown, strangeModule]);
  for (const raw of ["support.started", "financeiro", "support\""]) assert.ok(!serialized.includes(raw), raw);
});
