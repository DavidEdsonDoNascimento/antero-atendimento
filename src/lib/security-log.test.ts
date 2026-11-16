import assert from "node:assert/strict";
import { test } from "node:test";

import { logSecurityEvent, securityLogEntry } from "./security-log.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-16T12:00:00.000Z");

test("recusa vira uma linha com tipo, id, instante, ação, motivo, usuário, organização e SQLSTATE", () => {
  assert.deepEqual(
    securityLogEntry({ action: "organization.set_status", reason: "access_denied", userId: USER, organizationId: ORG, sqlState: "42501" }, NOW, "evt-1"),
    {
      type: "security",
      event: "admin.denied",
      id: "evt-1",
      at: "2026-11-16T12:00:00.000Z",
      action: "organization.set_status",
      reason: "access_denied",
      userId: USER,
      organizationId: ORG,
      sqlState: "42501",
    },
  );
});

test("entrada da requisição não sai crua: organização inválida, SQLSTATE fora do formato e usuário ausente", () => {
  const entry = securityLogEntry(
    {
      action: "organization.set_module",
      reason: "invalid_input",
      userId: "a@b.com",
      organizationId: "'; DROP TABLE x; -- <script>",
      sqlState: "permission denied for table organizations",
    },
    NOW,
    "evt-2",
  );
  assert.equal(entry.userId, null);
  assert.equal(entry.organizationId, "invalid");
  assert.equal("sqlState" in entry, false);
  assert.doesNotMatch(JSON.stringify(entry), /DROP|script|@|permission denied/);
});

test("sem organização na operação, o campo não aparece; ids são normalizados em minúsculas", () => {
  const entry = securityLogEntry({ action: "admin.access", reason: "not_platform_admin", userId: USER.toUpperCase() }, NOW, "evt-3");
  assert.equal(entry.userId, USER);
  assert.equal("organizationId" in entry, false);
});

test("logSecurityEvent escreve uma linha JSON em console.warn e devolve o id do registro", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => lines.push(line));
  const id = logSecurityEvent({ action: "admin.access", reason: "not_platform_admin", userId: USER });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.id, id);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(parsed.type, "security");
});
