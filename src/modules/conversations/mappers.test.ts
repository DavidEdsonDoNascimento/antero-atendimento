import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  buildLastMessageExcerpt,
  LAST_MESSAGE_EXCERPT_MAX_LENGTH,
  mapConversationDetailRow,
  mapConversationListRow,
  mapMessageRow,
} from "./mappers.ts";
import type {
  ConversationAssignedMemberRow,
  ConversationChannelRow,
  ConversationContactRow,
  ConversationDetailRow,
  ConversationLastMessageRow,
  ConversationListRow,
  MessageHistoryRow,
} from "./rows.ts";

const contactRow: ConversationContactRow = {
  id: randomUUID(),
  name: "Maria Souza",
  phone_number: "+5511999999999",
};

const channelRow: ConversationChannelRow = {
  id: randomUUID(),
  display_name: "Comercial",
  phone_number: "+5511888888888",
};

const assignedRow: ConversationAssignedMemberRow = {
  user_id: randomUUID(),
  profile: { id: randomUUID(), full_name: "João Atendente" },
};

const lastMessageRow: ConversationLastMessageRow = {
  id: randomUUID(),
  direction: "inbound",
  sender_type: "contact",
  content: "Olá, preciso de ajuda",
  created_at: "2024-01-01T10:00:00Z",
};

const baseListRow: ConversationListRow = {
  id: randomUUID(),
  status: "waiting",
  started_at: "2024-01-01T09:00:00Z",
  last_message_at: "2024-01-01T10:00:00Z",
  contact: contactRow,
  whatsapp_account: channelRow,
  assigned_member: assignedRow,
  last_message: [lastMessageRow],
};

test("mapConversationListRow: conversa com atendente e última mensagem", () => {
  const item = mapConversationListRow(baseListRow);

  assert.equal(item.id, baseListRow.id);
  assert.equal(item.status, "waiting");
  assert.deepEqual(item.contact, {
    id: contactRow.id,
    name: "Maria Souza",
    phoneNumber: "+5511999999999",
  });
  assert.deepEqual(item.channel, {
    id: channelRow.id,
    displayName: "Comercial",
    phoneNumber: "+5511888888888",
  });
  assert.deepEqual(item.assignee, { userId: assignedRow.user_id, fullName: "João Atendente" });
  assert.equal(item.startedAt, "2024-01-01T09:00:00Z");
  assert.equal(item.lastMessageAt, "2024-01-01T10:00:00Z");
  assert.ok(item.lastMessage);
  assert.equal(item.lastMessage?.id, lastMessageRow.id);
  assert.equal(item.lastMessage?.direction, "inbound");
  assert.equal(item.lastMessage?.sender, "contact");
  assert.equal(item.lastMessage?.excerpt, "Olá, preciso de ajuda");
  assert.equal(item.lastMessage?.createdAt, "2024-01-01T10:00:00Z");
});

test("mapConversationListRow: conversa sem atendente (assigned_member null)", () => {
  const row: ConversationListRow = { ...baseListRow, assigned_member: null };
  const item = mapConversationListRow(row);
  assert.equal(item.assignee, null);
});

test("mapConversationListRow: conversa sem última mensagem (array vazio, formato real do embed com limit(1))", () => {
  const row: ConversationListRow = { ...baseListRow, last_message: [] };
  const item = mapConversationListRow(row);
  assert.equal(item.lastMessage, null);
});

test("mapConversationListRow: sem atendente e sem última mensagem ao mesmo tempo", () => {
  const row: ConversationListRow = { ...baseListRow, assigned_member: null, last_message: [] };
  const item = mapConversationListRow(row);
  assert.equal(item.assignee, null);
  assert.equal(item.lastMessage, null);
});

test("mapConversationDetailRow: detalhe completo, campos snake_case convertidos", () => {
  const detailRow: ConversationDetailRow = {
    id: baseListRow.id,
    status: "human",
    started_at: "2024-01-01T09:00:00Z",
    last_message_at: "2024-01-01T10:30:00Z",
    assigned_at: "2024-01-01T10:15:00Z",
    resolved_at: null,
    contact: contactRow,
    whatsapp_account: channelRow,
    assigned_member: assignedRow,
  };

  const detail = mapConversationDetailRow(detailRow);

  assert.equal(detail.id, detailRow.id);
  assert.equal(detail.status, "human");
  assert.deepEqual(detail.contact, {
    id: contactRow.id,
    name: "Maria Souza",
    phoneNumber: "+5511999999999",
  });
  assert.deepEqual(detail.channel, {
    id: channelRow.id,
    displayName: "Comercial",
    phoneNumber: "+5511888888888",
  });
  assert.deepEqual(detail.assignee, { userId: assignedRow.user_id, fullName: "João Atendente" });
  assert.equal(detail.startedAt, "2024-01-01T09:00:00Z");
  assert.equal(detail.lastMessageAt, "2024-01-01T10:30:00Z");
  assert.equal(detail.assignedAt, "2024-01-01T10:15:00Z");
  assert.equal(detail.resolvedAt, null);
});

test("mapConversationDetailRow: conversa resolvida (resolved_at preenchido, sem atendente)", () => {
  const detailRow: ConversationDetailRow = {
    id: randomUUID(),
    status: "resolved",
    started_at: "2024-01-01T09:00:00Z",
    last_message_at: "2024-01-01T10:30:00Z",
    assigned_at: null,
    resolved_at: "2024-01-01T11:00:00Z",
    contact: contactRow,
    whatsapp_account: channelRow,
    assigned_member: null,
  };

  const detail = mapConversationDetailRow(detailRow);
  assert.equal(detail.assignee, null);
  assert.equal(detail.assignedAt, null);
  assert.equal(detail.resolvedAt, "2024-01-01T11:00:00Z");
});

test("mapMessageRow: campos snake_case convertidos corretamente", () => {
  const row: MessageHistoryRow = {
    id: randomUUID(),
    direction: "outbound",
    sender_type: "user",
    message_type: "text",
    content: "Como posso ajudar?",
    delivery_status: "sent",
    sender_user_id: randomUUID(),
    created_at: "2024-01-01T10:05:00Z",
  };

  const item = mapMessageRow(row);

  assert.deepEqual(item, {
    id: row.id,
    direction: "outbound",
    sender: "user",
    messageType: "text",
    content: "Como posso ajudar?",
    deliveryStatus: "sent",
    senderUserId: row.sender_user_id,
    createdAt: "2024-01-01T10:05:00Z",
  });
});

test("mapMessageRow: sender_user_id nulo (mensagem de contato/bot/sistema)", () => {
  const row: MessageHistoryRow = {
    id: randomUUID(),
    direction: "inbound",
    sender_type: "contact",
    message_type: "text",
    content: "Oi",
    delivery_status: "delivered",
    sender_user_id: null,
    created_at: "2024-01-01T10:00:00Z",
  };

  const item = mapMessageRow(row);
  assert.equal(item.senderUserId, null);
});

// --- buildLastMessageExcerpt -----------------------------------------------

test("buildLastMessageExcerpt: texto menor que o limite não é truncado", () => {
  assert.equal(buildLastMessageExcerpt("mensagem curta", 140), "mensagem curta");
});

test("buildLastMessageExcerpt: texto exatamente no limite não é truncado", () => {
  const content = "A".repeat(140);
  assert.equal(buildLastMessageExcerpt(content, 140), content);
});

test("buildLastMessageExcerpt: texto acima do limite é truncado com reticências", () => {
  const content = "A".repeat(150);
  assert.equal(buildLastMessageExcerpt(content, 140), `${"A".repeat(140)}…`);
});

test("buildLastMessageExcerpt: apara espaços nas pontas", () => {
  const content = `   ${"A".repeat(150)}   `;
  assert.equal(buildLastMessageExcerpt(content, 140), `${"A".repeat(140)}…`);
});

test("buildLastMessageExcerpt: usa LAST_MESSAGE_EXCERPT_MAX_LENGTH como padrão", () => {
  const content = "A".repeat(200);
  assert.equal(
    buildLastMessageExcerpt(content),
    `${"A".repeat(LAST_MESSAGE_EXCERPT_MAX_LENGTH)}…`,
  );
});

test("buildLastMessageExcerpt: emoji (par substituto) exatamente na borda do corte não quebra o surrogate", () => {
  const emoji = "😀"; // U+1F600 — par substituto, 2 unidades UTF-16, 1 code point
  // 139 'A' + 2 emojis = 141 code points; corte em 140 cairia, por índice
  // UTF-16 ingênuo, bem no meio do primeiro emoji.
  const content = "A".repeat(139) + emoji + emoji;

  const result = buildLastMessageExcerpt(content, 140);

  assert.ok(result.endsWith("…"));
  const withoutEllipsis = result.slice(0, -1);

  const lastCode = withoutEllipsis.charCodeAt(withoutEllipsis.length - 1);
  const endsWithLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  assert.equal(endsWithLoneHighSurrogate, false, "não deve terminar com metade de um par substituto");

  // 139 'A' + o primeiro emoji inteiro = 140 code points, o segundo emoji cai fora.
  assert.equal(Array.from(withoutEllipsis).length, 140);
  assert.ok(withoutEllipsis.endsWith(emoji));
  assert.equal(withoutEllipsis, "A".repeat(139) + emoji);
});

test("buildLastMessageExcerpt: string vazia após trim retorna vazia", () => {
  assert.equal(buildLastMessageExcerpt("   ", 140), "");
});
