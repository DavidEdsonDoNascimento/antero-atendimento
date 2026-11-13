import assert from "node:assert/strict";
import { test } from "node:test";

import { DEMO_FLOW_DEFINITION } from "../simulator/demo-flow.ts";
import { toMessageRecord } from "./actions.ts";
import { parseFlowDefinition, type FlowDefinition, type FlowDefinitionInput } from "./definition.ts";
import { advance, isSessionState, menuRows, startSession, type EngineInput, type EngineResult } from "./engine.ts";

function definitionOf(input: FlowDefinitionInput): FlowDefinition {
  const parsed = parseFlowDefinition(input);
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.issues));
  return parsed.definition;
}

const demo = definitionOf(DEMO_FLOW_DEFINITION);
const withHuman = { humanHandoffAvailable: true };
const withoutHuman = { humanHandoffAvailable: false };
const text = (value: string): EngineInput => ({ type: "text", text: value });

/** Percorre uma sequência de respostas a partir do início; devolve cada resultado. */
function play(definition: FlowDefinition, inputs: EngineInput[], context = withHuman): EngineResult[] {
  const results = [startSession(definition, text("Olá"), context)];
  for (const input of inputs) {
    const last = results.at(-1)!;
    assert.equal(last.status, "active", "a sessão terminou antes do fim do roteiro");
    results.push(advance(definition, last.state, input, context));
  }
  return results;
}

const kinds = (result: EngineResult) => result.outputs.map((output) => output.type);
const texts = (result: EngineResult) =>
  result.outputs.map((output) => (output.type === "text" ? output.text : output.type === "image" ? output.caption : output.body));

test("entrada: imagem de boas-vindas e menu principal, esperando a escolha", () => {
  const [start] = play(demo, []);
  assert.equal(start.status, "active");
  assert.deepEqual(kinds(start), ["image", "list"]);
  assert.equal(start.state.stepId, "menu-principal");
  assert.equal(start.state.turns, 1);
  assert.equal(start.reason, null);
});

test("primeira mensagem pedindo atendente já encaminha, sem passar pelo menu", () => {
  const start = startSession(demo, text("Quero falar com um atendente, por favor"), withHuman);
  assert.equal(start.status, "handed_off");
  assert.equal(start.reason, "human_requested");
  assert.deepEqual(kinds(start), ["text"]);
});

test("menu aceita número, id estável, título e seleção da lista interativa", () => {
  for (const input of [text("1"), text("reservas"), text("Reservas!"), { type: "selection", optionId: "reservas" } as const]) {
    const [, result] = play(demo, [input]);
    assert.equal(result.state.stepId, "menu-reservas", JSON.stringify(input));
    assert.deepEqual(result.state.menuStack, ["menu-principal"]);
  }
});

test("a escolha é pelo id, não pela posição: reordenar as opções não muda o destino de uma seleção", () => {
  const reordered = definitionOf({
    ...DEMO_FLOW_DEFINITION,
    steps: DEMO_FLOW_DEFINITION.steps.map((step) =>
      step.id === "menu-principal" && step.type === "menu" ? { ...step, options: [...step.options].reverse() } : step,
    ),
  });
  const [, original] = play(demo, [{ type: "selection", optionId: "informacoes" }]);
  const [, moved] = play(reordered, [{ type: "selection", optionId: "informacoes" }]);
  assert.equal(original.state.stepId, "menu-informacoes");
  assert.equal(moved.state.stepId, "menu-informacoes");
});

test("reserva completa: coleta nome e pessoas, avisa que depende de confirmação e encaminha", () => {
  const results = play(demo, [text("1"), { type: "selection", optionId: "cafe" }, text("Maria Exemplo"), text("4")]);
  const [, , cafe, name, done] = results;
  assert.deepEqual(kinds(cafe), ["text", "text"]);
  assert.equal(cafe.state.stepId, "cafe-nome");
  assert.equal(name.state.stepId, "cafe-pessoas");
  assert.equal(done.status, "handed_off");
  assert.equal(done.reason, "handoff_step");
  assert.match(texts(done)[0]!, /só vale depois da confirmação/);
  assert.deepEqual(done.state.answers, [
    { key: "nome", label: "Nome", value: "Maria Exemplo" },
    { key: "pessoas", label: "Pessoas", value: "4" },
  ]);
});

test("evento: três perguntas e encerramento próprio do encaminhamento", () => {
  const results = play(demo, [text("2"), text("Ana"), text("80"), text("20/12")]);
  const done = results.at(-1)!;
  assert.equal(done.status, "handed_off");
  assert.match(texts(done).join(" "), /equipe de eventos/);
  assert.deepEqual(done.state.answers.map((answer) => answer.key), ["nome", "convidados", "data"], "na ordem da coleta");
});

test("fornecedor: coleta oferta, empresa e telefone e encaminha", () => {
  const done = play(demo, [text("sou fornecedor"), text("Hortifrúti orgânico"), text("Sítio Exemplo"), text("+55 11 90000-0000")]).at(-1)!;
  assert.equal(done.status, "handed_off");
  assert.equal(done.state.answers.find((answer) => answer.key === "empresa")?.value, "Sítio Exemplo");
});

test("informações: responde e volta ao mesmo menu, sem empilhar", () => {
  const [, info, location] = play(demo, [text("4"), text("1")]);
  assert.equal(info.state.stepId, "menu-informacoes");
  assert.deepEqual(kinds(location), ["text", "list"]);
  assert.equal(location.state.stepId, "menu-informacoes");
  assert.deepEqual(location.state.menuStack, ["menu-principal"]);
});

test("voltar: de submenu ao anterior; de pergunta ao menu que a abriu; 'menu' vai ao principal", () => {
  const [, reservations, back] = play(demo, [text("1"), text("voltar")]);
  assert.equal(reservations.state.stepId, "menu-reservas");
  assert.equal(back.state.stepId, "menu-principal");
  assert.deepEqual(back.state.menuStack, []);

  const backRow = menuRows(demo, demo.steps.find((step) => step.id === "menu-reservas") as never).findIndex(
    (row) => row.id === "__back",
  );
  const [, , byNumber] = play(demo, [text("1"), text(String(backRow + 1))]);
  assert.equal(byNumber.state.stepId, "menu-principal");

  const [, , question, fromQuestion] = play(demo, [text("1"), text("cafe"), text("Voltar")]);
  assert.equal(question.state.stepId, "cafe-nome");
  assert.equal(fromQuestion.state.stepId, "menu-reservas");

  const [, , , main] = play(demo, [text("1"), text("jantar"), text("Menu")]);
  assert.equal(main.state.stepId, "menu-principal");
  assert.deepEqual(main.state.menuStack, []);
});

test("resposta inválida: avisa e repete uma vez; a segunda seguida encaminha", () => {
  const [, first, second] = play(demo, [text("banana"), text("99")]);
  assert.equal(first.status, "active");
  assert.deepEqual(kinds(first), ["text", "list"]);
  assert.equal(first.state.invalidAttempts, 1);
  assert.equal(second.status, "handed_off");
  assert.equal(second.reason, "invalid_attempts");
});

test("uma resposta válida zera as tentativas inválidas", () => {
  const [, invalid, valid] = play(demo, [text("banana"), text("1")]);
  assert.equal(invalid.state.invalidAttempts, 1);
  assert.equal(valid.state.invalidAttempts, 0);
});

test("pergunta: resposta fora do tamanho é inválida; 'atendente' só encaminha se for a resposta inteira", () => {
  const tooLong = play(demo, [text("2"), text("Ana"), text("x".repeat(41))]).at(-1)!;
  assert.equal(tooLong.state.stepId, "eventos-convidados");
  assert.equal(tooLong.state.invalidAttempts, 1);

  const freeText = play(demo, [text("3"), text("Atendimento com atendente dedicado")]).at(-1)!;
  assert.equal(freeText.status, "active");
  assert.equal(freeText.state.answers[0].value, "Atendimento com atendente dedicado");

  const asks = play(demo, [text("3"), text("Atendente")]).at(-1)!;
  assert.equal(asks.status, "handed_off");
  assert.equal(asks.reason, "human_requested");
});

test("pedido de atendente a qualquer momento, inclusive no meio de uma coleta", () => {
  const done = play(demo, [text("1"), text("cafe"), text("Maria"), text("humano")]).at(-1)!;
  assert.equal(done.status, "handed_off");
  assert.equal(done.reason, "human_requested");
  assert.deepEqual(done.state.answers, [{ key: "nome", label: "Nome", value: "Maria" }], "o que já foi coletado vai junto");
});

test("sem atendimento humano: avisa e volta ao menu, nunca encaminha", () => {
  const [, chosen] = play(demo, [text("5")], withoutHuman);
  assert.equal(chosen.status, "active");
  assert.deepEqual(kinds(chosen), ["text", "list"]);
  assert.match(texts(chosen)[0]!, /não temos atendimento humano/);
  assert.equal(chosen.state.stepId, "menu-principal");

  const [, , asked] = play(demo, [text("1"), text("atendente")], withoutHuman);
  assert.equal(asked.status, "active", "pedido avulso repete a etapa atual");
  assert.equal(asked.state.stepId, "menu-reservas");

  const [, , exhausted] = play(demo, [text("banana"), text("banana")], withoutHuman);
  assert.equal(exhausted.status, "completed");
  assert.equal(exhausted.reason, "handoff_unavailable");

  const greeting = startSession(demo, text("atendente"), withoutHuman);
  assert.equal(greeting.status, "active", "a saudação com 'atendente' apresenta o fluxo");
});

test("fluxo sem atendimento humano: termina de forma previsível na conclusão", () => {
  const faq = definitionOf({
    schemaVersion: 1,
    entryStepId: "menu",
    steps: [
      {
        type: "menu",
        id: "menu",
        text: "Dúvidas frequentes",
        options: [
          { id: "horario", title: "Horário", next: "horario" },
          { id: "sair", title: "Encerrar", next: "fim" },
        ],
      },
      { type: "message", id: "horario", text: "Abrimos das 9h às 18h.", next: "menu" },
      { type: "end", id: "fim", text: "Obrigado pelo contato!" },
    ],
  });
  const [, hours, end] = play(faq, [text("1"), text("encerrar")], withoutHuman);
  assert.deepEqual(kinds(hours), ["text", "list"]);
  assert.equal(end.status, "completed");
  assert.equal(end.reason, "flow_end");
  assert.deepEqual(texts(end), ["Obrigado pelo contato!"]);
});

test("limite de respostas por sessão encaminha", () => {
  const limited = definitionOf({ ...DEMO_FLOW_DEFINITION, settings: { maxTurns: 3 } });
  const [, , third] = play(limited, [text("4"), text("1")]);
  assert.equal(third.status, "active");
  const fourth = advance(limited, third.state, text("1"), withHuman);
  assert.equal(fourth.status, "handed_off");
  assert.equal(fourth.reason, "turn_limit");
});

test("proteção contra loop: a publicação recusa ciclo sem pausa e o motor falha com segurança se receber um", () => {
  const cyclic = {
    schemaVersion: 1 as const,
    entryStepId: "a",
    steps: [
      { type: "message" as const, id: "a", text: "A", next: "b" },
      { type: "message" as const, id: "b", text: "B", next: "a" },
    ],
  };
  const parsed = parseFlowDefinition(cyclic);
  assert.equal(parsed.ok, false);
  assert.match(JSON.stringify(parsed), /ciclo sem pausa/);

  // Definição que escapou da validação (ex.: gravada por fora): o motor não envia nada.
  const unchecked = { ...cyclic, settings: demo.settings } as unknown as FlowDefinition;
  const result = startSession(unchecked, text("oi"), withHuman);
  assert.equal(result.status, "failed");
  assert.ok(["step_limit", "output_limit"].includes(result.reason!));
  assert.deepEqual(result.outputs, []);
});

test("estado corrompido ou etapa removida: falha segura, sem mensagens", () => {
  const [start] = play(demo, []);
  const broken = advance(demo, { ...start.state, stepId: "nao-existe" }, text("1"), withHuman);
  assert.equal(broken.status, "failed");
  assert.equal(broken.reason, "invalid_state");
  assert.deepEqual(broken.outputs, []);
  assert.equal(isSessionState(start.state), true);
  assert.equal(isSessionState({ stepId: 1 }), false);
});

test("determinístico: a mesma entrada produz exatamente a mesma saída, sem alterar o estado recebido", () => {
  const [, menu] = play(demo, [text("1")]);
  const frozen = structuredClone(menu.state);
  const a = advance(demo, menu.state, text("cafe"), withHuman);
  const b = advance(demo, menu.state, text("cafe"), withHuman);
  assert.deepEqual(a, b);
  assert.deepEqual(menu.state, frozen);
});

test("validação: limites do WhatsApp, referências e ids", () => {
  const issues = (input: unknown) => {
    const parsed = parseFlowDefinition(input);
    return parsed.ok ? [] : parsed.issues.map((issue) => issue.message).join(" | ");
  };
  const base = DEMO_FLOW_DEFINITION;
  const replaceMenu = (patch: Record<string, unknown>) => ({
    ...base,
    steps: base.steps.map((step) => (step.id === "menu-reservas" ? { ...step, ...patch } : step)),
  });

  assert.match(String(issues(replaceMenu({ options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, title: `Opção ${i}`, next: "menu-principal" })) }))), /até 10/);
  assert.notDeepEqual(issues(replaceMenu({ options: [{ id: "a", title: "Título com mais de vinte e quatro", next: "menu-principal" }] })), []);
  assert.match(String(issues(replaceMenu({ options: [{ id: "a", title: "A", next: "sumiu" }] }))), /destino inexistente/);
  assert.match(String(issues(replaceMenu({ options: [{ id: "__back", title: "A", next: "menu-principal" }] }))), /id de opção/);
  assert.match(String(issues({ ...base, steps: [...base.steps, base.steps[0]] })), /etapa duplicada/);
  assert.match(String(issues({ ...base, mainMenuStepId: undefined })), /exige mainMenuStepId/);
  assert.notDeepEqual(
    issues({ ...base, steps: base.steps.map((step) => (step.type === "image" ? { ...step, url: "http://exemplo.invalid/a.jpg" } : step)) }),
    [],
    "imagem só por https",
  );
  assert.deepEqual(issues(base), []);
});

test("registro das mensagens: lista vira texto legível numerado, com o payload completo", () => {
  const [start] = play(demo, []);
  const [image, list] = start.outputs.map(toMessageRecord);
  assert.equal(image.messageType, "image");
  assert.match(image.content, /Bem-vindo/);
  assert.equal(list.messageType, "interactive");
  assert.match(list.content, /1\. Reservas — Pré-reserve/);
  assert.match(list.content, /5\. Falar com atendente/);
  assert.equal(list.payload.type, "list");
});
