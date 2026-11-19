import assert from "node:assert/strict";
import { test } from "node:test";

import { ChannelInputError, parseChannelInput } from "./channel-input.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const valid = { organization: ORG, "phone-number-id": "123456789012345", "waba-id": "987654321098765" };

test("cadastro de canal: argumentos válidos, desconectado por padrão", () => {
  assert.deepEqual(parseChannelInput(valid), {
    organizationId: ORG,
    phoneNumberId: "123456789012345",
    wabaId: "987654321098765",
    displayPhone: null,
    displayName: null,
    status: "disconnected",
  });
  const full = parseChannelInput({ ...valid, organization: ORG.toUpperCase(), "display-phone": "+5511912345678", "display-name": " Atendimento ", status: "connected" });
  assert.equal(full.organizationId, ORG);
  assert.equal(full.displayName, "Atendimento");
  assert.equal(full.status, "connected");
});

test("cadastro de canal: recusas com mensagem clara", () => {
  for (const [patch, message] of [
    [{ organization: "x" }, /--organization/],
    [{ organization: undefined }, /--organization/],
    [{ "phone-number-id": "12ab" }, /--phone-number-id/],
    [{ "phone-number-id": "1234" }, /--phone-number-id/],
    [{ "waba-id": "" }, /--waba-id/],
    [{ "waba-id": "123456789012345" }, /identificadores diferentes/],
    [{ "display-phone": "11 91234-5678" }, /--display-phone/],
    [{ "display-name": "x".repeat(121) }, /--display-name/],
    [{ "display-name": "nome\ncom quebra" }, /--display-name/],
    [{ status: "on" }, /--status/],
  ] as const) {
    assert.throws(() => parseChannelInput({ ...valid, ...patch }), (error: unknown) => error instanceof ChannelInputError && message.test(error.message));
  }
});
