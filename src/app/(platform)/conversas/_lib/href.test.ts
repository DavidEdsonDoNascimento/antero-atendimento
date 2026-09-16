import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationsHref } from "./href.ts";

test("buildConversationsHref: sem opções aponta para a lista sem query string", () => {
  assert.equal(buildConversationsHref({}), "/conversas");
});

test("buildConversationsHref: com conversationId aponta para a rota de detalhe", () => {
  assert.equal(buildConversationsHref({ conversationId: "abc-123" }), "/conversas/abc-123");
});

test("buildConversationsHref: inclui status quando presente", () => {
  assert.equal(buildConversationsHref({ status: "waiting" }), "/conversas?status=waiting");
});

test("buildConversationsHref: inclui cursor da lista quando presente", () => {
  assert.equal(buildConversationsHref({ cursor: "xyz" }), "/conversas?cursor=xyz");
});

test("buildConversationsHref: inclui cursor de mensagens como parâmetro 'antes'", () => {
  assert.equal(
    buildConversationsHref({ conversationId: "abc-123", messagesCursor: "older-cursor" }),
    "/conversas/abc-123?antes=older-cursor",
  );
});

test("buildConversationsHref: combina conversationId, status, cursor e messagesCursor", () => {
  const href = buildConversationsHref({
    conversationId: "abc-123",
    status: "human",
    cursor: "list-cursor",
    messagesCursor: "msg-cursor",
  });
  assert.equal(href, "/conversas/abc-123?status=human&cursor=list-cursor&antes=msg-cursor");
});

test("buildConversationsHref: codifica caracteres especiais no cursor", () => {
  const href = buildConversationsHref({ cursor: "a+b/c=" });
  const url = new URL(href, "http://localhost");
  assert.equal(url.searchParams.get("cursor"), "a+b/c=");
});
