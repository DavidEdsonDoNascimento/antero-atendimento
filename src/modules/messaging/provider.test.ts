import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderUnavailableError, SIMULATED_MESSAGE_ID_PREFIX, providerFor, simulatedProvider } from "./provider.ts";

const message = {
  channel: { id: "00000000-0000-4000-8000-000000000001", provider: "development" as const, externalAccountId: null },
  to: "+5511900000001",
  text: "Olá",
  idempotencyKey: "00000000-0000-4000-8000-000000000002",
};

test("canal development usa o provedor simulado", () => {
  const provider = providerFor("development");
  assert.equal(provider, simulatedProvider);
  assert.equal(provider.simulated, true);
});

test("provedor simulado aceita e devolve id externo marcado como simulado, único por envio", async () => {
  const first = await simulatedProvider.sendText(message);
  const second = await simulatedProvider.sendText(message);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.ok(first.externalMessageId.startsWith(SIMULATED_MESSAGE_ID_PREFIX));
  assert.doesNotMatch(first.externalMessageId, /^wamid\./);
  assert.notEqual(first.externalMessageId, second.externalMessageId);
});

test("cloud_api ainda não tem provedor: erro explícito, sem envio silencioso", () => {
  assert.throws(() => providerFor("cloud_api"), ProviderUnavailableError);
});

test("provedor simulado aceita as ações da automação (texto, imagem, lista) sem rede", async () => {
  const { channel, to, idempotencyKey } = message;
  for (const action of [
    { type: "text" as const, text: "Olá" },
    { type: "image" as const, url: "https://exemplo.invalid/a.jpg" },
    { type: "list" as const, body: "Escolha", button: "Ver", sections: [{ rows: [{ id: "a", title: "A" }] }] },
  ]) {
    const result = await simulatedProvider.send({ channel, to, idempotencyKey, action });
    assert.equal(result.ok, true);
    if (result.ok) assert.ok(result.externalMessageId.startsWith(SIMULATED_MESSAGE_ID_PREFIX));
  }
});
