import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFlowDefinition } from "../automations/definition.ts";
import { startSession } from "../automations/engine.ts";
import { DEMO_FLOW_DEFINITION } from "../simulator/demo-flow.ts";
import { CloudApiFormatError, selectionFromListReply, toCloudApiMessage } from "./cloud-api.ts";

test("texto, imagem e lista viram o corpo da Cloud API, sem rede", () => {
  assert.deepEqual(toCloudApiMessage("+5511900000001", { type: "text", text: "Olá" }), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "5511900000001",
    type: "text",
    text: { body: "Olá", preview_url: false },
  });
  const image = toCloudApiMessage("+5511900000001", { type: "image", url: "https://exemplo.invalid/a.jpg", caption: "Oi" });
  assert.deepEqual(image.image, { link: "https://exemplo.invalid/a.jpg", caption: "Oi" });

  const list = toCloudApiMessage("+5511900000001", {
    type: "list",
    header: "Cabeçalho",
    body: "Escolha",
    button: "Ver opções",
    sections: [{ rows: [{ id: "reservas", title: "Reservas", description: "Pré-reserva" }] }],
  });
  assert.equal(list.type, "interactive");
  assert.deepEqual((list.interactive as { action: unknown }).action, {
    button: "Ver opções",
    sections: [{ rows: [{ id: "reservas", title: "Reservas", description: "Pré-reserva" }] }],
  });
});

test("todas as ações do fluxo demonstrativo cabem nos limites da Cloud API", () => {
  const parsed = parseFlowDefinition(DEMO_FLOW_DEFINITION);
  assert.ok(parsed.ok);
  const start = startSession(parsed.definition, { type: "text", text: "Olá" }, { humanHandoffAvailable: true });
  for (const action of start.outputs) assert.doesNotThrow(() => toCloudApiMessage("+5511900000001", action));
});

test("limites recusados antes do envio: linhas, títulos, botão e link", () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Linha ${i}` }));
  const list = (patch: object) => ({ type: "list" as const, body: "Escolha", button: "Ver", sections: [{ rows: rows.slice(0, 2) }], ...patch });
  assert.throws(() => toCloudApiMessage("+5511900000001", list({ sections: [{ rows }] })), CloudApiFormatError);
  assert.throws(() => toCloudApiMessage("+5511900000001", list({ button: "Um botão longo demais!" })), CloudApiFormatError);
  assert.throws(
    () => toCloudApiMessage("+5511900000001", list({ sections: [{ rows: [{ id: "a", title: "x".repeat(25) }] }] })),
    CloudApiFormatError,
  );
  assert.throws(() => toCloudApiMessage("+5511900000001", { type: "image", url: "http://exemplo.invalid/a.jpg" }), CloudApiFormatError);
});

test("resposta selecionada da lista vira seleção pelo id estável", () => {
  assert.deepEqual(selectionFromListReply({ id: "reservas" }), { type: "selection", optionId: "reservas" });
  assert.equal(selectionFromListReply({ id: "" }), null);
  assert.equal(selectionFromListReply({}), null);
});
