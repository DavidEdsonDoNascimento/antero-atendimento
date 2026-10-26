import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { mapConversationDetailRow, mapConversationListRow } from "./mappers.ts";
import {
  buildConversationDetailQuery,
  buildConversationListQuery,
  buildConversationOwnershipQuery,
  buildMessageHistoryQuery,
  toConversationDetailRow,
  toConversationListRow,
  type ConversationDetailSqlRow,
  type ConversationListSqlRow,
} from "./sql.ts";

const orgId = randomUUID();
const conversationId = randomUUID();
const cursorId = randomUUID();
const cursorAt = "2026-03-10T13:00:00.000001+00:00";

/** Nenhum valor recebido aparece no texto SQL: só como parâmetro. */
function assertParameterized(text: string, values: readonly unknown[]) {
  for (const value of values) {
    if (typeof value === "string") assert.ok(!text.includes(value), `valor interpolado no SQL: ${value}`);
  }
  const placeholders = new Set(text.match(/\$\d+/g));
  assert.equal(placeholders.size, values.length, "cada parâmetro tem exatamente um marcador");
}

test("lista sem filtro: só organização + limite (limit + 1), ordem determinística", () => {
  const query = buildConversationListQuery(orgId, { cursor: null, limit: 20 });
  assert.deepEqual(query.values, [orgId, 21]);
  assert.match(query.text, /c\.organization_id = \$1::uuid/);
  assert.match(query.text, /ORDER BY c\.last_message_at DESC, c\.id DESC\s+LIMIT \$2::int\s+\) c/);
  assert.match(query.text, /\) c[\s\S]*LEFT JOIN LATERAL[\s\S]*ORDER BY c\.last_message_at DESC, c\.id DESC$/);
  assert.doesNotMatch(query.text, /c\.status (?:=|<>)/);
  assertParameterized(query.text, query.values);
});

test("lista com status 'open': condição fixa, sem parâmetro extra", () => {
  const query = buildConversationListQuery(orgId, { status: "open", cursor: null, limit: 5 });
  assert.match(query.text, /c\.status <> 'resolved'/);
  assert.deepEqual(query.values, [orgId, 6]);
});

test("lista com status exato: valor só como parâmetro com cast para o enum", () => {
  const query = buildConversationListQuery(orgId, { status: "human", cursor: null, limit: 5 });
  assert.match(query.text, /c\.status = \$2::public\.conversation_status/);
  assert.deepEqual(query.values, [orgId, "human", 6]);
  assertParameterized(query.text, query.values);
});

test("lista com cursor: comparação composta (last_message_at, id) parametrizada", () => {
  const query = buildConversationListQuery(orgId, {
    status: "waiting",
    cursor: { lastMessageAt: cursorAt, id: cursorId },
    limit: 2,
  });
  assert.match(query.text, /\(c\.last_message_at, c\.id\) < \(\$3::timestamptz, \$4::uuid\)/);
  assert.deepEqual(query.values, [orgId, "waiting", cursorAt, cursorId, 3]);
  assertParameterized(query.text, query.values);
});

test("valor hostil no status nunca entra no texto SQL", () => {
  const hostile = "waiting'; DROP TABLE public.messages; --";
  const query = buildConversationListQuery(orgId, {
    status: hostile as never,
    cursor: null,
    limit: 1,
  });
  assert.ok(!query.text.includes("DROP"));
  assert.equal(query.values[1], hostile);
});

test("última mensagem: LATERAL pela FK tripla, desempate por id", () => {
  const { text } = buildConversationListQuery(orgId, { cursor: null, limit: 1 });
  assert.match(text, /LEFT JOIN LATERAL/);
  assert.match(text, /m\.organization_id = c\.organization_id/);
  assert.match(text, /m\.conversation_id = c\.id/);
  assert.match(text, /m\.whatsapp_account_id = c\.whatsapp_account_id/);
  assert.match(text, /ORDER BY m\.created_at DESC, m\.id DESC\s+LIMIT 1/);
});

test("relações pelas FKs compostas (organization_id + id)", () => {
  const { text } = buildConversationDetailQuery(orgId, conversationId);
  assert.match(text, /ct\.organization_id = c\.organization_id AND ct\.id = c\.contact_id/);
  assert.match(text, /wa\.organization_id = c\.organization_id AND wa\.id = c\.whatsapp_account_id/);
  assert.match(text, /LEFT JOIN public\.organization_members am\s+ON am\.organization_id = c\.organization_id AND am\.user_id = c\.assigned_user_id/);
});

test("detalhe e posse: organização e conversa como parâmetros", () => {
  for (const query of [
    buildConversationDetailQuery(orgId, conversationId),
    buildConversationOwnershipQuery(orgId, conversationId),
  ]) {
    assert.deepEqual(query.values, [orgId, conversationId]);
    assert.match(query.text, /c\.organization_id = \$1::uuid AND c\.id = \$2::uuid/);
    assertParameterized(query.text, query.values);
  }
});

test("histórico: ordem decrescente, keyset (created_at, id) e limit + 1", () => {
  const first = buildMessageHistoryQuery(orgId, conversationId, { cursor: null, limit: 50 });
  assert.deepEqual(first.values, [orgId, conversationId, 51]);
  assert.match(first.text, /ORDER BY m\.created_at DESC, m\.id DESC\s+LIMIT \$3::int$/);
  assert.doesNotMatch(first.text, /m\.created_at, m\.id\) </);

  const next = buildMessageHistoryQuery(orgId, conversationId, {
    cursor: { createdAt: cursorAt, id: cursorId },
    limit: 2,
  });
  assert.match(next.text, /\(m\.created_at, m\.id\) < \(\$3::timestamptz, \$4::uuid\)/);
  assert.deepEqual(next.values, [orgId, conversationId, cursorAt, cursorId, 3]);
  assertParameterized(next.text, next.values);
});

const baseSqlRow = {
  id: randomUUID(),
  status: "human" as const,
  started_at: "2026-03-10T09:00:00+00:00",
  last_message_at: "2026-03-10T10:00:00.000001+00:00",
  contact_id: randomUUID(),
  contact_name: null,
  contact_phone_number: "+5511999999999",
  channel_id: randomUUID(),
  channel_display_name: "Comercial",
  channel_phone_number: null,
  assignee_user_id: randomUUID(),
  assignee_full_name: "João Atendente",
};

const listSqlRow: ConversationListSqlRow = {
  ...baseSqlRow,
  last_message_id: randomUUID(),
  last_message_direction: "outbound",
  last_message_sender_type: "user",
  last_message_content: "  Olá  ",
  last_message_created_at: "2026-03-10T10:00:00.000001+00:00",
};

test("toConversationListRow: formato de rows.ts (objetos embutidos, last_message em array)", () => {
  const row = toConversationListRow(listSqlRow);
  assert.deepEqual(row, {
    id: listSqlRow.id,
    status: "human",
    started_at: listSqlRow.started_at,
    last_message_at: listSqlRow.last_message_at,
    contact: { id: listSqlRow.contact_id, name: null, phone_number: "+5511999999999" },
    whatsapp_account: { id: listSqlRow.channel_id, display_name: "Comercial", phone_number: null },
    assigned_member: {
      user_id: listSqlRow.assignee_user_id,
      profile: { id: listSqlRow.assignee_user_id, full_name: "João Atendente" },
    },
    last_message: [
      {
        id: listSqlRow.last_message_id,
        direction: "outbound",
        sender_type: "user",
        content: "  Olá  ",
        created_at: listSqlRow.last_message_created_at,
      },
    ],
  });
  // e o mapeador existente aceita o resultado sem alteração
  const item = mapConversationListRow(row);
  assert.equal(item.lastMessage?.excerpt, "Olá");
  assert.equal(item.lastMessage?.createdAt, "2026-03-10T10:00:00.000001+00:00");
});

test("toConversationListRow: conversa sem mensagens → last_message [] → lastMessage null", () => {
  const row = toConversationListRow({
    ...listSqlRow,
    last_message_id: null,
    last_message_direction: null,
    last_message_sender_type: null,
    last_message_content: null,
    last_message_created_at: null,
  });
  assert.deepEqual(row.last_message, []);
  assert.equal(mapConversationListRow(row).lastMessage, null);
});

test("toConversationListRow: sem atendente → assigned_member null", () => {
  const row = toConversationListRow({ ...listSqlRow, assignee_user_id: null, assignee_full_name: null });
  assert.equal(row.assigned_member, null);
  assert.equal(mapConversationListRow(row).assignee, null);
});

test("perfil do atendente oculto pela RLS: nome null, sem quebrar o mapeador", () => {
  const row = toConversationListRow({ ...listSqlRow, assignee_full_name: null });
  assert.deepEqual(mapConversationListRow(row).assignee, {
    userId: listSqlRow.assignee_user_id,
    fullName: null,
  });
});

test("toConversationDetailRow: inclui assigned_at/resolved_at e passa pelo mapeador", () => {
  const detailSqlRow: ConversationDetailSqlRow = {
    ...baseSqlRow,
    assigned_at: "2026-03-10T09:30:00.123456+00:00",
    resolved_at: null,
  };
  const detail = mapConversationDetailRow(toConversationDetailRow(detailSqlRow));
  assert.equal(detail.assignedAt, "2026-03-10T09:30:00.123456+00:00");
  assert.equal(detail.resolvedAt, null);
  assert.equal(detail.channel.displayName, "Comercial");
  assert.equal(detail.contact.name, null);
  assert.deepEqual(detail.assignee, { userId: baseSqlRow.assignee_user_id, fullName: "João Atendente" });
});
