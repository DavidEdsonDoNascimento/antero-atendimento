import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attendanceActionsFor,
  attendanceErrorCodeOf,
  attendanceErrorMessage,
  replyWindowOf,
  type AttendanceErrorCode,
} from "./attendance.ts";

const now = new Date("2026-11-09T12:00:00.000Z");

test("janela: aberta até 24 h depois da última mensagem recebida", () => {
  assert.deepEqual(replyWindowOf("2026-11-08T12:00:01.000Z", now), { open: true, closesAt: "2026-11-09T12:00:01.000Z" });
  assert.deepEqual(replyWindowOf("2026-11-08T12:00:00.000Z", now), { open: false, closedAt: "2026-11-09T12:00:00.000Z" });
  assert.deepEqual(replyWindowOf("2026-11-01T08:00:00.000000+00:00", now), { open: false, closedAt: "2026-11-02T08:00:00.000Z" });
});

test("janela: sem mensagem do cliente não há janela", () => {
  assert.deepEqual(replyWindowOf(null, now), { open: false, closedAt: null });
});

const me = { userId: "u-me", role: "attendant" as const };

test("ações: aguardando ou bot sem responsável podem ser assumidas; nada mais", () => {
  for (const status of ["waiting", "bot"] as const) {
    assert.deepEqual(attendanceActionsFor({ status, assigneeUserId: null }, me), {
      canClaim: true,
      canResolve: false,
      canReply: false,
      isMine: false,
    });
  }
});

test("ações: em atendimento pelo próprio usuário — responde e resolve", () => {
  assert.deepEqual(attendanceActionsFor({ status: "human", assigneeUserId: "u-me" }, me), {
    canClaim: false,
    canResolve: true,
    canReply: true,
    isMine: true,
  });
});

test("ações: em atendimento por outro — atendente não age; owner/admin só resolve", () => {
  const other = { status: "human" as const, assigneeUserId: "u-other" };
  assert.deepEqual(attendanceActionsFor(other, me), { canClaim: false, canResolve: false, canReply: false, isMine: false });
  for (const role of ["owner", "admin"] as const) {
    assert.deepEqual(attendanceActionsFor(other, { userId: "u-me", role }), {
      canClaim: false,
      canResolve: true,
      canReply: false,
      isMine: false,
    });
  }
});

test("ações: resolvida não é assumida nem respondida (reabre com mensagem do cliente)", () => {
  const resolved = attendanceActionsFor({ status: "resolved", assigneeUserId: "u-me" }, me);
  assert.equal(resolved.canClaim, false);
  assert.equal(resolved.canReply, false);
  assert.equal(resolved.canResolve, false);
});

test("ações: aguardando com responsável de outro não é assumida (sem transferência)", () => {
  assert.equal(attendanceActionsFor({ status: "waiting", assigneeUserId: "u-other" }, me).canClaim, false);
});

test("erros: cada SQLSTATE de 0008 tem motivo e mensagem; outros não são reconhecidos", () => {
  const expected: Record<string, AttendanceErrorCode> = {
    "28000": "access_denied",
    "42501": "access_denied",
    P0002: "not_found",
    AT001: "assigned_to_other",
    AT002: "not_eligible",
    AT003: "not_assignee",
    AT004: "window_closed",
    AT005: "invalid_content",
    AT006: "idempotency_conflict",
    AT007: "channel_unavailable",
    AT008: "provider_unavailable",
  };
  for (const [state, code] of Object.entries(expected)) {
    assert.equal(attendanceErrorCodeOf(state), code, state);
    assert.ok(attendanceErrorMessage[code], code);
  }
  for (const state of [undefined, "23505", "22P02", "AT999"]) assert.equal(attendanceErrorCodeOf(state), undefined, String(state));
});
