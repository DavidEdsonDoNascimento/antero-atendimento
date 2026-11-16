// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import {
  draftGraphIssues,
  flowDefinitionSchema,
  flowSettingsSchema,
  flowWarnings,
  FLOW_SCHEMA_VERSION,
  parseFlowDraft,
  type FlowDefinition,
  type FlowSettings,
  type FlowStepInput,
  type GraphIssue,
} from "./definition.ts";
import { ENGINE_LIMITS, WHATSAPP_LIMITS } from "./limits.ts";
import { normalizeText } from "./text.ts";

// Lógica pura do editor de fluxos (E3B): sem I/O, sem React. O editor trabalha
// sobre a própria definição v1 (com campos ainda em branco) e não tem regras
// próprias: os erros saem de `flowDefinitionSchema` e das regras do grafo de
// `definition.ts`, só traduzidos para quem não conhece a estrutura.

export type StepType = FlowStepInput["type"];
export type EditorStep = FlowStepInput;
export type EditorMenuStep = Extract<EditorStep, { type: "menu" }>;
export type EditorOption = EditorMenuStep["options"][number];

/** Rascunho em edição: a definição v1 com todos os campos que a tela mostra presentes. */
export type EditorDefinition = {
  schemaVersion: typeof FLOW_SCHEMA_VERSION;
  entryStepId: string;
  mainMenuStepId?: string;
  settings: FlowSettings;
  steps: EditorStep[];
};

export const STEP_TYPES: StepType[] = ["message", "image", "menu", "question", "handoff", "end"];

export const STEP_TYPE_LABEL: Record<StepType, string> = {
  message: "Mensagem",
  image: "Imagem",
  menu: "Menu de opções",
  question: "Pergunta",
  handoff: "Encaminhar para a equipe",
  end: "Conclusão",
};

const ID_PREFIX: Record<StepType, string> = {
  message: "mensagem",
  image: "imagem",
  menu: "menu",
  question: "pergunta",
  handoff: "equipe",
  end: "fim",
};

/** Gera identificadores internos; injetável para os testes serem determinísticos. */
export type IdSource = (prefix: string) => string;

export const randomId: IdSource = (prefix) => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}-${Array.from(bytes, (byte) => (byte % 36).toString(36)).join("")}`;
};

function uniqueId(prefix: string, taken: Set<string>, ids: IdSource): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = ids(prefix);
    if (!taken.has(id)) return id;
  }
  throw new Error("não foi possível gerar um identificador único");
}

function stepIds(definition: EditorDefinition): Set<string> {
  return new Set(definition.steps.map((step) => step.id));
}

function optionIds(definition: EditorDefinition): Set<string> {
  return new Set(definition.steps.flatMap((step) => (step.type === "menu" ? step.options.map((option) => option.id) : [])));
}

export function defaultSettings(): FlowSettings {
  return flowSettingsSchema.parse({});
}

/**
 * Chave estável da informação coletada, derivada do nome que o usuário vê
 * ("Nome completo" → `nome_completo`). Gerada uma vez; depois não muda, mesmo
 * que o nome mude (o histórico das sessões usa a chave).
 */
export function variableKeyFor(label: string, taken: Iterable<string>): string {
  const base =
    normalizeText(label)
      .replace(/ /g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 34) || "resposta";
  const used = new Set(taken);
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
  return key;
}

function questionKeys(definition: EditorDefinition, except?: string): string[] {
  return definition.steps.flatMap((step) => (step.type === "question" && step.id !== except ? [step.variable] : []));
}

export function newOption(definition: EditorDefinition, ids: IdSource = randomId): EditorOption {
  return { id: uniqueId("opcao", optionIds(definition), ids), title: "", next: "" };
}

/** Etapa nova, com os campos obrigatórios em branco: os erros mostram o que falta. */
export function newStep(definition: EditorDefinition, type: StepType, ids: IdSource = randomId): EditorStep {
  const id = uniqueId(ID_PREFIX[type], stepIds(definition), ids);
  switch (type) {
    case "message":
      return { type, id, name: "", text: "", next: "" };
    case "image":
      return { type, id, name: "", caption: "", next: "" };
    case "menu":
      return {
        type,
        id,
        name: "",
        text: "",
        button: "Ver opções",
        options: [newOption(definition, ids)],
        showBack: false,
        showMainMenu: false,
      };
    case "question":
      return { type, id, name: "", text: "", label: "", variable: variableKeyFor("", questionKeys(definition)), next: "" };
    case "handoff":
      return { type, id, name: "", text: "" };
    case "end":
      return { type, id, name: "", text: "" };
  }
}

/** Fluxo inicial de uma automação nova: boas-vindas → menu → falar com a equipe. */
export function starterDefinition(ids: IdSource = randomId): EditorDefinition {
  let definition: EditorDefinition = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entryStepId: "",
    settings: defaultSettings(),
    steps: [],
  };
  const welcome = newStep(definition, "message", ids);
  definition = { ...definition, steps: [welcome] };
  const menu = newStep(definition, "menu", ids) as EditorMenuStep;
  definition = { ...definition, steps: [welcome, menu] };
  const handoff = newStep(definition, "handoff", ids);
  return {
    ...definition,
    entryStepId: welcome.id,
    mainMenuStepId: menu.id,
    steps: [
      { ...welcome, name: "Boas-vindas", text: "Olá! Seja bem-vindo. Como podemos ajudar?", next: menu.id } as EditorStep,
      {
        ...menu,
        name: "Menu principal",
        text: "Escolha uma das opções abaixo.",
        options: [{ ...menu.options[0], title: "Falar com atendente", next: handoff.id }],
      },
      { ...handoff, name: "Falar com a equipe" },
    ],
  };
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asOptionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Completa uma etapa lida do banco com os campos que a tela edita. */
function normalizeStep(raw: Record<string, unknown> & { type: StepType; id: string }): EditorStep {
  const base = { id: raw.id, name: asString(raw.name) };
  switch (raw.type) {
    case "message":
      return { ...base, type: "message", text: asString(raw.text), next: asString(raw.next) };
    case "image":
      return {
        ...base,
        type: "image",
        ...(asOptionalString(raw.url) !== undefined ? { url: asString(raw.url) } : {}),
        ...(asOptionalString(raw.mediaId) !== undefined ? { mediaId: asString(raw.mediaId) } : {}),
        caption: asString(raw.caption),
        next: asString(raw.next),
      };
    case "menu": {
      const options = Array.isArray(raw.options) ? (raw.options as Record<string, unknown>[]) : [];
      return {
        ...base,
        type: "menu",
        header: asString(raw.header),
        text: asString(raw.text),
        footer: asString(raw.footer),
        button: typeof raw.button === "string" ? raw.button : "Ver opções",
        ...(asOptionalString(raw.sectionTitle) ? { sectionTitle: asString(raw.sectionTitle) } : {}),
        options: options.map((option) => ({
          id: asString(option.id),
          title: asString(option.title),
          description: asString(option.description),
          ...(Array.isArray(option.keywords) ? { keywords: option.keywords.filter((word) => typeof word === "string") } : {}),
          next: asString(option.next),
        })),
        showBack: raw.showBack === true,
        showMainMenu: raw.showMainMenu === true,
        invalidMessage: asString(raw.invalidMessage),
      };
    }
    case "question":
      return {
        ...base,
        type: "question",
        text: asString(raw.text),
        label: asString(raw.label),
        variable: asString(raw.variable),
        ...(Number.isInteger(raw.minLength) ? { minLength: raw.minLength as number } : {}),
        ...(Number.isInteger(raw.maxLength) ? { maxLength: raw.maxLength as number } : {}),
        invalidMessage: asString(raw.invalidMessage),
        next: asString(raw.next),
      };
    case "handoff":
      return {
        ...base,
        type: "handoff",
        text: asString(raw.text),
        unavailableText: asString(raw.unavailableText),
        unavailableNext: asString(raw.unavailableNext),
      };
    case "end":
      return { ...base, type: "end", text: asString(raw.text) };
  }
}

/** Abre no editor um rascunho gravado (ou o conteúdo de uma versão). `null`: não é uma definição v1. */
export function toEditorDefinition(input: unknown): EditorDefinition | null {
  const parsed = parseFlowDraft(input);
  if (!parsed.ok) return null;
  const { draft } = parsed;
  const settings = flowSettingsSchema.safeParse(draft.settings ?? {});
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entryStepId: draft.entryStepId,
    ...(draft.mainMenuStepId ? { mainMenuStepId: draft.mainMenuStepId } : {}),
    // Configuração inválida (mensagem apagada, por exemplo) abre como está, sobre os padrões.
    settings: settings.success ? settings.data : { ...defaultSettings(), ...(draft.settings as Partial<FlowSettings>) },
    steps: draft.steps.map((step) => normalizeStep(step as Record<string, unknown> & { type: StepType; id: string })),
  };
}

const blank = (value: unknown) => typeof value !== "string" || value.trim() === "";

/** Remove do objeto os campos opcionais em branco (o schema os trataria como texto vazio). */
function dropBlank<T extends object>(value: T, keys: readonly string[]): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) if (blank(copy[key])) delete copy[key];
  return copy as T;
}

const OPTIONAL_TEXT: Record<StepType, readonly string[]> = {
  message: ["name"],
  image: ["name", "caption", "url", "mediaId"],
  menu: ["name", "header", "footer", "sectionTitle", "invalidMessage"],
  question: ["name", "invalidMessage"],
  handoff: ["name", "text", "unavailableText", "unavailableNext"],
  end: ["name", "text"],
};

/** O rascunho como é gravado e validado: sem os campos opcionais deixados em branco. */
export function cleanDefinition(definition: EditorDefinition): EditorDefinition {
  const steps = definition.steps.map((step) => {
    const cleaned = dropBlank(step, OPTIONAL_TEXT[step.type]);
    if (cleaned.type !== "menu") return cleaned;
    return {
      ...cleaned,
      options: cleaned.options.map((option) => {
        const withoutBlank = dropBlank(option, ["description"]);
        if (withoutBlank.keywords?.length !== 0) return withoutBlank;
        const copy = { ...withoutBlank };
        delete copy.keywords;
        return copy;
      }),
    };
  });
  const { mainMenuStepId, ...rest } = definition;
  return { ...rest, ...(blank(mainMenuStepId) ? {} : { mainMenuStepId }), steps };
}

// ---------------------------------------------------------------------------
// Operações sobre o rascunho (sempre devolvem um novo objeto)
// ---------------------------------------------------------------------------

export function updateStep(definition: EditorDefinition, id: string, change: (step: EditorStep) => EditorStep): EditorDefinition {
  return { ...definition, steps: definition.steps.map((step) => (step.id === id ? change(step) : step)) };
}

/** Acrescenta a etapa logo depois de `afterId` (ou no fim). */
export function insertStep(definition: EditorDefinition, step: EditorStep, afterId?: string): EditorDefinition {
  const index = afterId ? definition.steps.findIndex((candidate) => candidate.id === afterId) : -1;
  const steps = [...definition.steps];
  steps.splice(index >= 0 ? index + 1 : steps.length, 0, step);
  return { ...definition, steps, entryStepId: definition.entryStepId || step.id };
}

function move<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const copy = [...items];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}

/** Muda a etapa de lugar na lista. Só organiza a tela: a navegação é pelos destinos. */
export function moveStep(definition: EditorDefinition, id: string, delta: -1 | 1): EditorDefinition {
  const steps = move(definition.steps, definition.steps.findIndex((step) => step.id === id), delta);
  return steps === definition.steps ? definition : { ...definition, steps };
}

export type StepReference =
  | { kind: "entry" }
  | { kind: "mainMenu" }
  | { kind: "next"; stepId: string }
  | { kind: "unavailableNext"; stepId: string }
  | { kind: "option"; stepId: string; optionId: string };

/** Quem leva até a etapa: o que fica sem destino se ela for excluída. */
export function referencesTo(definition: EditorDefinition, targetId: string): StepReference[] {
  const references: StepReference[] = [];
  if (definition.entryStepId === targetId) references.push({ kind: "entry" });
  if (definition.mainMenuStepId === targetId) references.push({ kind: "mainMenu" });
  for (const step of definition.steps) {
    if (step.id === targetId) continue;
    if ("next" in step && step.next === targetId) references.push({ kind: "next", stepId: step.id });
    if (step.type === "handoff" && step.unavailableNext === targetId) references.push({ kind: "unavailableNext", stepId: step.id });
    if (step.type === "menu") {
      for (const option of step.options) {
        if (option.next === targetId) references.push({ kind: "option", stepId: step.id, optionId: option.id });
      }
    }
  }
  return references;
}

/**
 * Exclui a etapa. As referências a ela ficam como estão — apontando para uma
 * etapa que não existe — e viram erros que impedem publicar até alguém escolher
 * outro destino: a navegação nunca muda sem o usuário ver.
 */
export function removeStep(definition: EditorDefinition, id: string): EditorDefinition {
  return { ...definition, steps: definition.steps.filter((step) => step.id !== id) };
}

export function updateOption(
  definition: EditorDefinition,
  stepId: string,
  optionId: string,
  change: (option: EditorOption) => EditorOption,
): EditorDefinition {
  return updateStep(definition, stepId, (step) =>
    step.type === "menu"
      ? { ...step, options: step.options.map((option) => (option.id === optionId ? change(option) : option)) }
      : step,
  );
}

export function addOption(definition: EditorDefinition, stepId: string, ids: IdSource = randomId): EditorDefinition {
  const option = newOption(definition, ids);
  return updateStep(definition, stepId, (step) => (step.type === "menu" ? { ...step, options: [...step.options, option] } : step));
}

export function removeOption(definition: EditorDefinition, stepId: string, optionId: string): EditorDefinition {
  return updateStep(definition, stepId, (step) =>
    step.type === "menu" ? { ...step, options: step.options.filter((option) => option.id !== optionId) } : step,
  );
}

/** Reordena as opções: muda a numeração que o cliente vê, nunca o id da opção. */
export function moveOption(definition: EditorDefinition, stepId: string, optionId: string, delta: -1 | 1): EditorDefinition {
  return updateStep(definition, stepId, (step) =>
    step.type === "menu"
      ? { ...step, options: move(step.options, step.options.findIndex((option) => option.id === optionId), delta) }
      : step,
  );
}

/**
 * Novo nome da informação coletada. `rekey`: a pergunta ainda não foi gravada,
 * então a chave acompanha o nome; depois de gravada, a chave fica.
 */
export function setQuestionLabel(definition: EditorDefinition, stepId: string, label: string, rekey: boolean): EditorDefinition {
  return updateStep(definition, stepId, (step) =>
    step.type === "question"
      ? { ...step, label, ...(rekey ? { variable: variableKeyFor(label, questionKeys(definition, stepId)) } : {}) }
      : step,
  );
}

// ---------------------------------------------------------------------------
// Nomes e resumo
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Como a etapa aparece nas listas e seletores: o nome dado, ou o começo do texto. */
export function stepLabel(step: EditorStep): string {
  if (step.name?.trim()) return step.name.trim();
  const text = step.type === "image" ? step.caption : step.type === "menu" ? step.text : "text" in step ? step.text : undefined;
  const snippet = text?.trim().replace(/\s+/g, " ");
  if (step.type === "question" && step.label.trim()) return `Pergunta: ${truncate(step.label.trim(), 40)}`;
  return snippet ? truncate(snippet, 40) : `${STEP_TYPE_LABEL[step.type]} sem título`;
}

export function describeReference(definition: EditorDefinition, reference: StepReference): string {
  if (reference.kind === "entry") return "É a primeira etapa do fluxo";
  if (reference.kind === "mainMenu") return "É o menu principal do fluxo";
  const step = definition.steps.find((candidate) => candidate.id === reference.stepId);
  const label = step ? stepLabel(step) : "Etapa";
  if (reference.kind === "next") return `“${label}” segue para ela`;
  if (reference.kind === "unavailableNext") return `“${label}” segue para ela quando não há atendimento humano`;
  const optionId = reference.optionId;
  const option = step?.type === "menu" ? step.options.find((candidate) => candidate.id === optionId) : undefined;
  return `Opção “${option?.title.trim() || "sem título"}” do menu “${label}”`;
}

export type FlowOutline = Record<StepType, number> & { steps: number };

export function flowOutline(definition: Pick<EditorDefinition, "steps">): FlowOutline {
  const outline: FlowOutline = { steps: definition.steps.length, message: 0, image: 0, menu: 0, question: 0, handoff: 0, end: 0 };
  for (const step of definition.steps) outline[step.type]++;
  return outline;
}

// ---------------------------------------------------------------------------
// Erros e avisos em português, a partir do schema do motor
// ---------------------------------------------------------------------------

export type EditorIssue = {
  /** `error` impede publicar; `warning` não impede nada. Nenhum dos dois impede salvar o rascunho. */
  severity: "error" | "warning";
  /** Etapa do problema; ausente para a configuração geral do fluxo. */
  stepId?: string;
  optionId?: string;
  /** Campo da etapa, da opção ou do fluxo (`entryStepId`, `settings.handoffMessage`...). */
  field: string;
  message: string;
};

type Path = readonly PropertyKey[];

const REQUIRED_MESSAGE: Record<string, string> = {
  text: "Escreva o texto desta etapa.",
  title: "Dê um título para esta opção.",
  label: "Dê um nome para a informação que esta pergunta coleta.",
  button: "Escreva o texto do botão que abre as opções.",
  next: "Escolha o que acontece depois desta etapa.",
  options: "Adicione pelo menos uma opção.",
  steps: "Adicione pelo menos uma etapa.",
  entryStepId: "Escolha a primeira etapa do fluxo.",
  mainMenuStepId: "Escolha o menu principal do fluxo.",
};

type Location = { stepId?: string; optionId?: string; field: string };

function locate(definition: EditorDefinition, path: Path): Location {
  if (path[0] === "steps" && typeof path[1] === "number") {
    const step = definition.steps[path[1]];
    if (path[2] === "options" && typeof path[3] === "number" && step?.type === "menu") {
      return { stepId: step.id, optionId: step.options[path[3]]?.id, field: String(path[4] ?? "option") };
    }
    return { stepId: step?.id, field: path[2] === undefined ? "step" : String(path[2]) };
  }
  if (path[0] === "settings") return { field: `settings.${String(path[1])}` };
  return { field: String(path[0] ?? "flow") };
}

function valueAt(root: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (value, key) => (value !== null && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[key] : undefined),
    root,
  );
}

type RawIssue = { code: string; path: Path; maximum?: number | bigint; minimum?: number | bigint; origin?: string };

function fieldMessage(definition: EditorDefinition, issue: RawIssue, at: Location): string {
  const { field } = at;
  const isTarget = field === "next" || field === "unavailableNext";
  if (issue.code === "too_small" && issue.origin === "string") {
    if (field.startsWith("settings.")) return "Escreva esta mensagem.";
    return REQUIRED_MESSAGE[field] ?? "Preencha este campo.";
  }
  if (issue.code === "too_big" && issue.origin === "string") {
    const length = String(valueAt(definition, issue.path) ?? "").trim().length;
    return `Use no máximo ${issue.maximum} caracteres (agora são ${length}).`;
  }
  if (issue.code === "too_small" && issue.origin === "array") return REQUIRED_MESSAGE[field] ?? "Adicione pelo menos um item.";
  if (issue.code === "too_big" && issue.origin === "array") {
    if (field === "options") return `Um menu aceita no máximo ${WHATSAPP_LIMITS.listRows} opções.`;
    if (field === "steps") return `Um fluxo aceita no máximo ${ENGINE_LIMITS.steps} etapas.`;
    return "Há itens demais nesta lista.";
  }
  if (issue.code === "too_small" || issue.code === "too_big") {
    return `Use um número entre ${issue.minimum ?? 1} e ${issue.maximum ?? "o máximo permitido"}.`;
  }
  if (isTarget) {
    if (at.optionId) return "Esta opção precisa direcionar para uma etapa.";
    return field === "next" ? REQUIRED_MESSAGE.next : "Escolha uma etapa válida.";
  }
  if (field === "entryStepId" || field === "mainMenuStepId") return REQUIRED_MESSAGE[field];
  if (field === "url") return "Use um link completo que comece com https://.";
  if (field === "mediaId") return "A imagem escolhida não é válida. Envie a imagem de novo.";
  if (field === "id" || field === "variable") return "Identificador interno inválido. Exclua e recrie esta etapa.";
  return "Revise este campo.";
}

function graphMessage(issue: GraphIssue, at: Location): string {
  switch (issue.kind) {
    case "duplicate_step":
      return "Há duas etapas com o mesmo identificador interno. Exclua e recrie uma delas.";
    case "entry_missing":
      return "A primeira etapa do fluxo foi excluída. Escolha outra.";
    case "main_menu_not_menu":
      return "O menu principal precisa ser uma etapa do tipo menu.";
    case "missing_target":
      return at.optionId
        ? "A etapa para onde esta opção levava foi excluída. Escolha outro destino."
        : "A etapa seguinte foi excluída. Escolha outro destino.";
    case "image_source":
      return "Escolha uma imagem enviada ou informe um link https (só um dos dois).";
    case "min_over_max":
      return "O tamanho mínimo da resposta é maior que o máximo.";
    case "duplicate_option":
      return "Opção repetida neste menu. Exclua e recrie uma delas.";
    case "duplicate_title":
      return "Já existe outra opção com este título neste menu.";
    case "too_many_rows":
      return `Este menu mostra ${issue.params?.rows ?? "mais de 10"} linhas contando “Voltar” e “Menu principal”; o WhatsApp aceita até ${WHATSAPP_LIMITS.listRows}.`;
    case "main_menu_required":
      return "Para mostrar “Menu principal”, escolha nas configurações qual é o menu principal do fluxo.";
    case "no_pause_cycle":
      return "Estas mensagens voltam para si mesmas sem esperar o cliente responder. Inclua um menu ou uma pergunta no caminho.";
  }
}

/** Campo da tela onde o problema do grafo aparece. */
function graphField(issue: GraphIssue, at: Location): string {
  return issue.kind === "image_source" ? "image" : at.field;
}

/**
 * Tudo o que impede (erros) ou merece atenção (avisos) antes de publicar, já
 * no lugar em que aparece na tela. Mesmo schema da publicação e do motor.
 */
export function editorIssues(definition: EditorDefinition): EditorIssue[] {
  const cleaned = cleanDefinition(definition);
  const issues: EditorIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: EditorIssue) => {
    const key = `${issue.stepId ?? ""}|${issue.optionId ?? ""}|${issue.field}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  const result = flowDefinitionSchema.safeParse(cleaned);
  if (!result.success) {
    for (const raw of result.error.issues) {
      if (raw.code === "custom") continue;
      const at = locate(cleaned, raw.path);
      push({ severity: "error", ...at, message: fieldMessage(cleaned, raw as RawIssue, at) });
    }
  }
  // As regras do grafo também sobre o rascunho ainda inválido (ver `draftGraphIssues`).
  for (const issue of draftGraphIssues(cleaned)) {
    const at = locate(cleaned, issue.path);
    push({ severity: "error", ...at, field: graphField(issue, at), message: graphMessage(issue, at) });
  }
  for (const warning of flowWarnings(cleaned as unknown as FlowDefinition)) {
    push({
      severity: "warning",
      stepId: warning.stepId,
      field: "reachability",
      message: "Nenhum caminho do fluxo leva a esta etapa: o cliente nunca vai vê-la.",
    });
  }
  return issues;
}

export function hasBlockingIssues(issues: EditorIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
