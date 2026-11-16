import assert from "node:assert/strict";
import { test } from "node:test";

import { DEMO_FLOW_DEFINITION } from "../simulator/demo-flow.ts";
import { parseFlowDefinition, type FlowDefinition } from "./definition.ts";
import {
  addOption,
  cleanDefinition,
  describeReference,
  editorIssues,
  flowOutline,
  hasBlockingIssues,
  insertStep,
  moveOption,
  moveStep,
  newStep,
  referencesTo,
  removeOption,
  removeStep,
  setQuestionLabel,
  starterDefinition,
  stepLabel,
  toEditorDefinition,
  updateOption,
  updateStep,
  variableKeyFor,
  type EditorDefinition,
  type EditorMenuStep,
  type EditorStep,
  type IdSource,
  type StepType,
} from "./editor.ts";
import { EMPTY_PREVIEW, previewReply, type PreviewConversation } from "./preview.ts";

/** Identificadores previsíveis: prefixo-1, prefixo-2... */
function sequentialIds(): IdSource {
  let n = 0;
  return (prefix) => `${prefix}-${++n}`;
}

function publishable(definition: EditorDefinition): FlowDefinition {
  const parsed = parseFlowDefinition(cleanDefinition(definition));
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.issues));
  return parsed.definition;
}

/** Monta um fluxo só com as operações do editor, como a tela faz. */
class Builder {
  definition: EditorDefinition;
  readonly ids = sequentialIds();

  constructor() {
    this.definition = { schemaVersion: 1, entryStepId: "", settings: starterDefinition(this.ids).settings, steps: [] };
  }

  add<T extends StepType>(type: T, fields: Record<string, unknown>): string {
    const step = { ...newStep(this.definition, type, this.ids), ...fields } as EditorStep;
    this.definition = insertStep(this.definition, step);
    return step.id;
  }

  menu(fields: Record<string, unknown>, options: { title: string; next: string }[]): string {
    const id = this.add("menu", fields);
    this.definition = updateStep(this.definition, id, (step) => ({ ...(step as EditorMenuStep), options: [] }));
    for (const option of options) {
      this.definition = addOption(this.definition, id, this.ids);
      const menu = this.definition.steps.find((step) => step.id === id) as EditorMenuStep;
      this.definition = updateOption(this.definition, id, menu.options.at(-1)!.id, (current) => ({ ...current, ...option }));
    }
    return id;
  }

  link(id: string, next: string) {
    this.definition = updateStep(this.definition, id, (step) => ({ ...step, next }) as EditorStep);
  }
}

const withHuman = { humanHandoffAvailable: true };

function play(definition: FlowDefinition, replies: (string | { option: string })[], context = withHuman): PreviewConversation {
  let conversation = previewReply(definition, EMPTY_PREVIEW, { type: "text", text: "Olá" }, "Olá", context);
  for (const reply of replies) {
    conversation =
      typeof reply === "string"
        ? previewReply(definition, conversation, { type: "text", text: reply }, reply, context)
        : previewReply(definition, conversation, { type: "selection", optionId: reply.option }, reply.option, context);
  }
  return conversation;
}

const botTexts = (conversation: PreviewConversation) =>
  conversation.entries.flatMap((entry) =>
    entry.from !== "bot"
      ? []
      : [entry.action.type === "text" ? entry.action.text : entry.action.type === "image" ? (entry.action.caption ?? "") : entry.action.body],
  );

test("fluxo inicial de uma automação nova já é publicável e conversa pela prévia", () => {
  const starter = starterDefinition(sequentialIds());
  assert.deepEqual(editorIssues(starter), []);
  const definition = publishable(starter);
  const menu = starter.steps[1] as EditorMenuStep;
  const conversation = play(definition, [{ option: menu.options[0].id }]);
  assert.equal(conversation.status, "handed_off");
  assert.deepEqual(conversation.entries.at(-1), { from: "system", status: "handed_off", reason: "handoff_step" });
});

test("etapa nova: campos obrigatórios em branco viram erros em português, no campo certo", () => {
  const builder = new Builder();
  const id = builder.add("message", {});
  const issues = editorIssues(builder.definition);
  assert.ok(hasBlockingIssues(issues));
  assert.deepEqual(
    issues.filter((issue) => issue.stepId === id).map(({ field, message }) => ({ field, message })),
    [
      { field: "text", message: "Escreva o texto desta etapa." },
      { field: "next", message: "Escolha o que acontece depois desta etapa." },
    ],
  );
  assert.ok(issues.every((issue) => !/invalid|expected|too_small/i.test(issue.message)), "nenhuma mensagem técnica");
});

test("opção sem destino, título repetido e limite de linhas do WhatsApp", () => {
  const builder = new Builder();
  const end = builder.add("end", { text: "Obrigado!" });
  const menu = builder.menu({ text: "Escolha" }, [
    { title: "Reservas", next: end },
    { title: "reservas", next: end },
    { title: "Eventos", next: "" },
  ]);
  const options = (builder.definition.steps.find((step) => step.id === menu) as EditorMenuStep).options;
  const byOption = (optionId: string) => editorIssues(builder.definition).filter((issue) => issue.optionId === optionId);
  assert.equal(byOption(options[2].id)[0].message, "Esta opção precisa direcionar para uma etapa.");
  assert.equal(byOption(options[1].id)[0].message, "Já existe outra opção com este título neste menu.");

  for (let n = 0; n < 8; n++) builder.definition = addOption(builder.definition, menu, builder.ids);
  const tooMany = editorIssues(builder.definition).find((issue) => issue.stepId === menu && issue.field === "options");
  assert.equal(tooMany?.message, "Um menu aceita no máximo 10 opções.");
});

test("navegação conta nas 10 linhas e “Menu principal” exige o menu principal do fluxo", () => {
  const builder = new Builder();
  const end = builder.add("end", {});
  const options = Array.from({ length: 9 }, (_, n) => ({ title: `Opção ${n + 1}`, next: end }));
  const menu = builder.menu({ text: "Escolha", showBack: true, showMainMenu: true }, options);
  const errorsOf = () => editorIssues(builder.definition).filter((issue) => issue.stepId === menu && issue.severity === "error");
  assert.deepEqual(
    errorsOf().map((issue) => [issue.field, issue.message]),
    [["showMainMenu", "Para mostrar “Menu principal”, escolha nas configurações qual é o menu principal do fluxo."]],
  );
  const main = builder.menu({ text: "Principal" }, [{ title: "Escolher", next: menu }]);
  builder.definition = { ...builder.definition, mainMenuStepId: main };
  assert.deepEqual(
    errorsOf().map((issue) => [issue.field, issue.message]),
    [["options", "Este menu mostra 11 linhas contando “Voltar” e “Menu principal”; o WhatsApp aceita até 10."]],
  );
});

test("texto acima do limite da Cloud API mostra o limite e o tamanho atual", () => {
  const builder = new Builder();
  const end = builder.add("end", {});
  builder.menu({ text: "x".repeat(1100) }, [{ title: "Um título longo demais para a lista", next: end }]);
  const messages = editorIssues(builder.definition).map((issue) => issue.message);
  assert.ok(messages.includes("Use no máximo 1024 caracteres (agora são 1100)."));
  assert.ok(messages.includes("Use no máximo 24 caracteres (agora são 35)."));
});

test("excluir etapa: dependências listadas, nada é religado sozinho e a publicação fica bloqueada", () => {
  const starter = starterDefinition(sequentialIds());
  const [welcome, menu, handoff] = starter.steps;
  const references = referencesTo(starter, handoff.id);
  assert.deepEqual(references, [{ kind: "option", stepId: menu.id, optionId: (menu as EditorMenuStep).options[0].id }]);
  assert.equal(describeReference(starter, references[0]), "Opção “Falar com atendente” do menu “Menu principal”");
  assert.deepEqual(
    referencesTo(starter, welcome.id).map((reference) => reference.kind),
    ["entry"],
  );

  const without = removeStep(starter, handoff.id);
  assert.equal((without.steps[1] as EditorMenuStep).options[0].next, handoff.id, "a opção continua apontando para a etapa excluída");
  const issues = editorIssues(without);
  assert.deepEqual(issues, [
    {
      severity: "error",
      stepId: menu.id,
      optionId: (menu as EditorMenuStep).options[0].id,
      field: "next",
      message: "A etapa para onde esta opção levava foi excluída. Escolha outro destino.",
    },
  ]);

  const noEntry = removeStep(starter, welcome.id);
  assert.equal(editorIssues(noEntry).find((issue) => issue.field === "entryStepId")?.message, "A primeira etapa do fluxo foi excluída. Escolha outra.");
});

test("erro de campo e destino excluído aparecem juntos (as regras do grafo valem no rascunho incompleto)", () => {
  const starter = starterDefinition(sequentialIds());
  const [welcome, menu, handoff] = starter.steps;
  const broken = updateStep(removeStep(starter, handoff.id), welcome.id, (step) => ({ ...step, text: " " }) as EditorStep);
  const fields = editorIssues(broken).map((issue) => `${issue.stepId}:${issue.field}`);
  assert.deepEqual(fields, [`${welcome.id}:text`, `${menu.id}:next`]);
});

test("ciclo só de mensagens é bloqueado; etapa inalcançável é só aviso", () => {
  const builder = new Builder();
  const a = builder.add("message", { text: "A" });
  const b = builder.add("message", { text: "B", next: a });
  builder.link(a, b);
  assert.ok(editorIssues(builder.definition).some((issue) => issue.message.startsWith("Estas mensagens voltam para si mesmas")));

  const starter = starterDefinition(sequentialIds());
  const orphan = newStep(starter, "end", sequentialIds());
  const withOrphan = insertStep(starter, { ...orphan, text: "Tchau" } as EditorStep);
  const issues = editorIssues(withOrphan);
  assert.deepEqual(issues.map((issue) => [issue.severity, issue.stepId]), [["warning", orphan.id]]);
  assert.equal(hasBlockingIssues(issues), false);
});

test("imagem: arquivo enviado OU link https, nunca os dois nem nenhum", () => {
  const builder = new Builder();
  const end = builder.add("end", {});
  const image = builder.add("image", { next: end });
  const issueOf = () => editorIssues(builder.definition).find((issue) => issue.stepId === image && issue.severity === "error");
  assert.equal(issueOf()?.field, "image");
  builder.definition = updateStep(builder.definition, image, (step) => ({ ...step, url: "http://exemplo.invalid/a.jpg" }) as EditorStep);
  assert.equal(issueOf()?.message, "Use um link completo que comece com https://.");
  builder.definition = updateStep(builder.definition, image, (step) => ({ ...step, url: "", mediaId: "6f1c1a52-3d4e-4f60-8a7b-9c0d1e2f3a4b" }) as EditorStep);
  assert.equal(issueOf(), undefined);
  const definition = publishable(builder.definition);
  const step = definition.steps.find((candidate) => candidate.id === image);
  assert.deepEqual(step?.type === "image" && { url: step.url, mediaId: step.mediaId }, {
    url: undefined,
    mediaId: "6f1c1a52-3d4e-4f60-8a7b-9c0d1e2f3a4b",
  });
  const conversation = play({ ...definition, entryStepId: image }, []);
  assert.deepEqual(conversation.entries[1], { from: "bot", action: { type: "image", mediaId: "6f1c1a52-3d4e-4f60-8a7b-9c0d1e2f3a4b" } });
});

test("ids estáveis: reordenar e renomear opções não troca o id; a chave da pergunta só acompanha o nome antes de gravar", () => {
  const starter = starterDefinition(sequentialIds());
  const menuId = starter.steps[1].id;
  let definition = addOption(starter, menuId, sequentialIds());
  const before = (definition.steps[1] as EditorMenuStep).options.map((option) => option.id);
  definition = moveOption(definition, menuId, before[1], -1);
  definition = updateOption(definition, menuId, before[0], (option) => ({ ...option, title: "Outro título" }));
  assert.deepEqual(
    (definition.steps[1] as EditorMenuStep).options.map((option) => option.id),
    [before[1], before[0]],
  );

  const question = newStep(definition, "question", sequentialIds());
  definition = insertStep(definition, question);
  definition = setQuestionLabel(definition, question.id, "Nome completo", true);
  const keyOf = () => definition.steps.find((step) => step.id === question.id)?.type === "question"
    ? (definition.steps.find((step) => step.id === question.id) as Extract<EditorStep, { type: "question" }>).variable
    : null;
  assert.equal(keyOf(), "nome_completo");
  definition = setQuestionLabel(definition, question.id, "Seu nome", false);
  assert.equal(keyOf(), "nome_completo", "depois de gravada, a chave não muda");
  assert.equal(variableKeyFor("Nome completo", ["nome_completo"]), "nome_completo_2");
  assert.equal(variableKeyFor("123 Ação!", []), "acao");
  assert.equal(variableKeyFor("😀", []), "resposta");
});

test("mover etapas só muda a ordem da lista, não a navegação", () => {
  const starter = starterDefinition(sequentialIds());
  const moved = moveStep(starter, starter.steps[2].id, -1);
  assert.deepEqual(moved.steps.map((step) => step.id), [starter.steps[0].id, starter.steps[2].id, starter.steps[1].id]);
  assert.deepEqual(publishable(moved).steps.find((step) => step.type === "menu"), publishable(starter).steps[1]);
  assert.equal(moveStep(starter, starter.steps[0].id, -1), starter);
});

test("formulário → definição: campos opcionais em branco somem e o resultado é o que o motor aceita", () => {
  const builder = new Builder();
  const end = builder.add("end", { text: "" });
  const handoff = builder.add("handoff", { text: "", unavailableText: "", unavailableNext: "" });
  builder.menu({ text: "Menu", header: "", footer: "  " }, [
    { title: "Fim", next: end },
    { title: "Equipe", next: handoff },
  ]);
  const cleaned = cleanDefinition(builder.definition);
  assert.deepEqual(cleaned.steps[0], { type: "end", id: end });
  assert.deepEqual(cleaned.steps[1], { type: "handoff", id: handoff });
  const menu = cleaned.steps[2] as EditorMenuStep;
  assert.equal("header" in menu || "footer" in menu, false);
  publishable(builder.definition);
});

test("abrir rascunho/versão gravada: o fluxo demonstrativo da E3A abre, salva igual e continua publicável", () => {
  const parsed = parseFlowDefinition(DEMO_FLOW_DEFINITION);
  assert.ok(parsed.ok);
  const opened = toEditorDefinition(parsed.definition);
  assert.ok(opened);
  assert.deepEqual(editorIssues(opened), []);
  assert.deepEqual(publishable(opened), parsed.definition, "restaurar uma versão não altera o seu conteúdo");
  assert.equal(stepLabel(opened.steps[0]), "Olá! Bem-vindo ao Recanto Exemplo. 🌿 E…");
  assert.equal(toEditorDefinition({ schemaVersion: 2, steps: [] }), null);
  assert.equal(toEditorDefinition("texto"), null);
});

test("rascunho incompleto também abre (mensagem geral apagada, opção sem destino)", () => {
  const starter = starterDefinition(sequentialIds());
  const broken = { ...cleanDefinition(starter), settings: { handoffMessage: "" } };
  const opened = toEditorDefinition(JSON.parse(JSON.stringify(broken)));
  assert.ok(opened);
  assert.equal(opened.settings.handoffMessage, "");
  assert.equal(opened.settings.backLabel, "Voltar");
  assert.deepEqual(
    editorIssues(opened).map((issue) => [issue.field, issue.message]),
    [["settings.handoffMessage", "Escreva esta mensagem."]],
  );
});

test("caso de validação comercial: restaurante com reservas montado só pelo editor, sem regra específica", () => {
  const b = new Builder();
  const welcome = b.add("message", { name: "Boas-vindas", text: "Olá! Bem-vindo ao Sítio Exemplo (dados fictícios)." });
  const schedule = b.add("image", {
    name: "Programação da semana",
    mediaId: "0b6a3c55-5f0e-4b9b-8f43-1d6c2a7e9b10",
    caption: "Programação da semana (exemplo).",
  });
  b.link(welcome, schedule);
  const handoff = b.add("handoff", { name: "Equipe", text: "Vou chamar alguém da equipe." });
  const notice = b.add("end", {
    name: "Aviso de confirmação",
    text: "Recebemos sua solicitação. A reserva só vale depois da confirmação da equipe.",
  });
  const people = b.add("question", { text: "Para quantas pessoas?", label: "Pessoas", variable: "pessoas", next: notice });
  const name = b.add("question", { text: "Qual é o seu nome completo?", label: "Nome", variable: "nome", next: people });
  const reservations = b.menu({ name: "Reservas", text: "Qual experiência?", showBack: true, showMainMenu: true }, [
    { title: "Café colonial", next: name },
    { title: "Jantar italiano", next: name },
    { title: "Almoço de domingo", next: name },
    { title: "Alterar reserva", next: handoff },
    { title: "Cancelar reserva", next: handoff },
  ]);
  const info = b.add("message", { name: "Informações", text: "Aberto de quinta a domingo (exemplo)." });
  const main = b.menu({ name: "Menu principal", text: "Como podemos ajudar?" }, [
    { title: "Fazer uma reserva", next: reservations },
    { title: "Fazer seu evento", next: handoff },
    { title: "Sou fornecedor", next: handoff },
    { title: "Outras informações", next: info },
    { title: "Falar com atendente", next: handoff },
    { title: "Sobre o espaço", next: info },
  ]);
  b.link(info, main);
  b.link(schedule, main);
  b.definition = { ...b.definition, entryStepId: welcome, mainMenuStepId: main };

  assert.deepEqual(editorIssues(b.definition), []);
  assert.deepEqual(flowOutline(b.definition), { steps: 9, message: 2, image: 1, menu: 2, question: 2, handoff: 1, end: 1 });
  const definition = publishable(b.definition);
  const options = (id: string) => (b.definition.steps.find((step) => step.id === id) as EditorMenuStep).options;

  const conversation = play(definition, [{ option: options(main)[0].id }, "2", "Maria Exemplo", "4"]);
  assert.equal(conversation.status, "completed");
  assert.deepEqual(conversation.state?.answers, [
    { key: "nome", label: "Nome", value: "Maria Exemplo" },
    { key: "pessoas", label: "Pessoas", value: "4" },
  ]);
  assert.match(botTexts(conversation).at(-1)!, /só vale depois da confirmação da equipe/);

  // Mudar a mensagem de boas-vindas muda a prévia na hora.
  const edited = publishable(updateStep(b.definition, welcome, (step) => ({ ...step, text: "Nova saudação" }) as EditorStep));
  assert.equal(botTexts(play(edited, []))[0], "Nova saudação");

  // Sem o módulo Atendimento, o encaminhamento avisa e termina — igual à execução real.
  const withoutHuman = play(definition, [{ option: options(main)[4].id }], { humanHandoffAvailable: false });
  assert.equal(withoutHuman.status, "completed");
  assert.deepEqual(withoutHuman.entries.at(-1), { from: "system", status: "completed", reason: "handoff_unavailable" });
});

test("prévia: conversa encerrada não muda, voltar e menu principal funcionam como na execução", () => {
  const parsed = parseFlowDefinition(DEMO_FLOW_DEFINITION);
  assert.ok(parsed.ok);
  const conversation = play(parsed.definition, [{ option: "reservas" }, "voltar", "atendente"]);
  assert.equal(conversation.status, "handed_off");
  const after = previewReply(parsed.definition, conversation, { type: "text", text: "oi" }, "oi", withHuman);
  assert.equal(after, conversation);
  assert.deepEqual(
    conversation.entries.filter((entry) => entry.from === "customer").map((entry) => entry.from === "customer" && entry.text),
    ["Olá", "reservas", "voltar", "atendente"],
  );
});

test("removeOption e insertStep: a primeira etapa nova vira o início de um fluxo vazio", () => {
  const empty: EditorDefinition = { schemaVersion: 1, entryStepId: "", settings: starterDefinition(sequentialIds()).settings, steps: [] };
  const step = newStep(empty, "menu", sequentialIds()) as EditorMenuStep;
  const withMenu = insertStep(empty, step);
  assert.equal(withMenu.entryStepId, step.id);
  const withoutOption = removeOption(withMenu, step.id, step.options[0].id);
  assert.equal(editorIssues(withoutOption).find((issue) => issue.field === "options")?.message, "Adicione pelo menos uma opção.");
});
