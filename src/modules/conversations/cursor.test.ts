import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  decodeConversationCursor,
  decodeMessageHistoryCursor,
  encodeConversationCursor,
  encodeMessageHistoryCursor,
} from "./cursor.ts";
import { InvalidCursorError } from "./errors.ts";

const SOME_ISO = "2024-03-15T12:34:56.789+00:00";
const SOME_UUID = randomUUID();

test("cursor de conversas: encode/decode preserva timestamp e UUID", () => {
  const encoded = encodeConversationCursor({
    lastMessageAt: SOME_ISO,
    id: SOME_UUID,
  });
  const decoded = decodeConversationCursor(encoded);
  assert.deepEqual(decoded, { lastMessageAt: SOME_ISO, id: SOME_UUID });
});

test("cursor de mensagens: encode/decode preserva timestamp e UUID", () => {
  const encoded = encodeMessageHistoryCursor({
    createdAt: SOME_ISO,
    id: SOME_UUID,
  });
  const decoded = decodeMessageHistoryCursor(encoded);
  assert.deepEqual(decoded, { createdAt: SOME_ISO, id: SOME_UUID });
});

test("cursor de conversas: aceita timestamp com 'Z' e com offset numérico", () => {
  const withZ = encodeConversationCursor({
    lastMessageAt: "2024-01-01T00:00:00Z",
    id: SOME_UUID,
  });
  const withOffset = encodeConversationCursor({
    lastMessageAt: "2024-01-01T00:00:00.123+00:00",
    id: SOME_UUID,
  });
  assert.equal(
    decodeConversationCursor(withZ).lastMessageAt,
    "2024-01-01T00:00:00Z",
  );
  assert.equal(
    decodeConversationCursor(withOffset).lastMessageAt,
    "2024-01-01T00:00:00.123+00:00",
  );
});

test("cursor de conversas: base64 inválido gera InvalidCursorError", () => {
  assert.throws(
    () => decodeConversationCursor("$$$not-base64$$$"),
    InvalidCursorError,
  );
});

test("cursor de mensagens: base64 inválido gera InvalidCursorError", () => {
  assert.throws(() => decodeMessageHistoryCursor("%%%"), InvalidCursorError);
});

test("cursor: base64 válido mas JSON inválido gera InvalidCursorError", () => {
  const notJson = Buffer.from("isto não é json {{{", "utf8").toString(
    "base64url",
  );
  assert.throws(() => decodeConversationCursor(notJson), InvalidCursorError);
});

test("cursor: JSON válido mas sem os campos exigidos gera InvalidCursorError", () => {
  const missingFields = Buffer.from(JSON.stringify({}), "utf8").toString(
    "base64url",
  );
  assert.throws(
    () => decodeConversationCursor(missingFields),
    InvalidCursorError,
  );
  assert.throws(
    () => decodeMessageHistoryCursor(missingFields),
    InvalidCursorError,
  );
});

test("cursor: falta apenas o id gera InvalidCursorError", () => {
  const raw = Buffer.from(
    JSON.stringify({ lastMessageAt: SOME_ISO }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decodeConversationCursor(raw), InvalidCursorError);
});

test("cursor: timestamp inválido gera InvalidCursorError", () => {
  const raw = Buffer.from(
    JSON.stringify({ lastMessageAt: "não é uma data", id: SOME_UUID }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decodeConversationCursor(raw), InvalidCursorError);
});

test("cursor: timestamp sem timezone (não-ISO com offset) gera InvalidCursorError", () => {
  const raw = Buffer.from(
    JSON.stringify({ lastMessageAt: "2024-01-01T00:00:00", id: SOME_UUID }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decodeConversationCursor(raw), InvalidCursorError);
});

test("cursor: UUID inválido gera InvalidCursorError", () => {
  const raw = Buffer.from(
    JSON.stringify({ lastMessageAt: SOME_ISO, id: "não-é-um-uuid" }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decodeConversationCursor(raw), InvalidCursorError);
});

test("cursor: tipo de cursor incorreto (cursor de mensagens decodificado como cursor de conversas) gera InvalidCursorError", () => {
  const messageCursor = encodeMessageHistoryCursor({
    createdAt: SOME_ISO,
    id: SOME_UUID,
  });
  assert.throws(
    () => decodeConversationCursor(messageCursor),
    InvalidCursorError,
  );
});

test("cursor: tipo de cursor incorreto (cursor de conversas decodificado como cursor de mensagens) gera InvalidCursorError", () => {
  const conversationCursor = encodeConversationCursor({
    lastMessageAt: SOME_ISO,
    id: SOME_UUID,
  });
  assert.throws(
    () => decodeMessageHistoryCursor(conversationCursor),
    InvalidCursorError,
  );
});

test("cursor: todo InvalidCursorError tem mensagem genérica fixa, sem ecoar o valor recebido", () => {
  const inputMarker = "cursor-input-marker";
  const attempts: string[] = [
    "$$$not-base64$$$",
    Buffer.from(`{"garbage": "${inputMarker}"`, "utf8").toString("base64url"),
    Buffer.from(
      JSON.stringify({ lastMessageAt: inputMarker, id: SOME_UUID }),
      "utf8",
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({ lastMessageAt: SOME_ISO, id: inputMarker }),
      "utf8",
    ).toString("base64url"),
  ];

  for (const raw of attempts) {
    try {
      decodeConversationCursor(raw);
      assert.fail("esperava InvalidCursorError");
    } catch (error) {
      assert.ok(error instanceof InvalidCursorError);
      assert.equal(error.message, "Cursor de paginação inválido.");
      assert.ok(!error.message.includes(inputMarker));
      assert.ok(!error.message.includes(raw));
    }
  }
});
