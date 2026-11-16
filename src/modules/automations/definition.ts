import { z } from "zod";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { ENGINE_LIMITS, WHATSAPP_LIMITS } from "./limits.ts";
import { normalizeText } from "./text.ts";

// Lógica pura (sem I/O) — sem `import "server-only"`, testável com `node --test`.

/**
 * Definição de um fluxo de automação: o que o editor (E3B) grava, o que é
 * publicado como versão imutável e o que o motor (`engine.ts`) interpreta.
 * Nenhuma regra de cliente: toda diferença entre empresas está aqui, como dado.
 *
 * Versionada por `schemaVersion`. Uma mudança incompatível cria a versão 2 e um
 * conversor; as versões publicadas antigas continuam sendo lidas como 1.
 */
export const FLOW_SCHEMA_VERSION = 1;

/** Ids de opção reservados para a navegação ("voltar" e "menu principal"). */
export const BACK_OPTION_ID = "__back";
export const MAIN_MENU_OPTION_ID = "__main";

const stepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "id de etapa: letras minúsculas, dígitos, - e _ (até 64)");
const optionId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "id de opção: letras minúsculas, dígitos, - e _ (até 64)");
const variableKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "variável: letra minúscula seguida de letras, dígitos ou _");
const text = (max: number) => z.string().trim().min(1).max(max);
const keywords = z.array(z.string().trim().min(1).max(60)).max(20);
/** Nome da etapa no editor (E3B). Só organiza a tela: o motor não o lê nem o envia. */
const stepName = z.string().trim().max(60).optional();

const messageStep = z.object({
  type: z.literal("message"),
  id: stepId,
  name: stepName,
  text: text(WHATSAPP_LIMITS.textBody),
  next: stepId,
});

const imageStep = z.object({
  type: z.literal("image"),
  id: stepId,
  name: stepName,
  /** Link público (https). Ou `mediaId`: exatamente um dos dois. */
  url: z
    .url({ protocol: /^https$/ })
    .max(WHATSAPP_LIMITS.imageUrl)
    .optional(),
  /** Imagem enviada pelo painel (`automation_media`, 0011), da mesma organização. */
  mediaId: z.uuid().optional(),
  caption: text(WHATSAPP_LIMITS.imageCaption).optional(),
  next: stepId,
});

const menuOption = z.object({
  /** Identificador estável: é o id da linha da lista no WhatsApp, não a posição. */
  id: optionId,
  title: text(WHATSAPP_LIMITS.listRowTitle),
  description: text(WHATSAPP_LIMITS.listRowDescription).optional(),
  /** Palavras que também escolhem esta opção (comparação exata, sem acento). */
  keywords: keywords.optional(),
  next: stepId,
});

const menuStep = z.object({
  type: z.literal("menu"),
  id: stepId,
  name: stepName,
  header: text(WHATSAPP_LIMITS.listHeader).optional(),
  text: text(WHATSAPP_LIMITS.listBody),
  footer: text(WHATSAPP_LIMITS.listFooter).optional(),
  button: text(WHATSAPP_LIMITS.listButton).default("Ver opções"),
  sectionTitle: text(WHATSAPP_LIMITS.listSectionTitle).optional(),
  options: z.array(menuOption).min(1).max(WHATSAPP_LIMITS.listRows),
  /** Acrescenta "Voltar" (menu anterior). */
  showBack: z.boolean().default(false),
  /** Acrescenta "Menu principal". */
  showMainMenu: z.boolean().default(false),
  invalidMessage: text(WHATSAPP_LIMITS.textBody).optional(),
});

const questionStep = z.object({
  type: z.literal("question"),
  id: stepId,
  name: stepName,
  text: text(WHATSAPP_LIMITS.textBody),
  /** Onde a resposta fica guardada na sessão. */
  variable: variableKey,
  /** Como o atendente vê o dado coletado. */
  label: text(60),
  minLength: z.number().int().min(1).max(1000).default(1),
  maxLength: z.number().int().min(1).max(1000).default(500),
  invalidMessage: text(WHATSAPP_LIMITS.textBody).optional(),
  next: stepId,
});

const handoffStep = z.object({
  type: z.literal("handoff"),
  id: stepId,
  name: stepName,
  /** Enviada antes de passar para a equipe. Sem ela, usa `settings.handoffMessage`. */
  text: text(WHATSAPP_LIMITS.textBody).optional(),
  /** Enviada quando a organização não tem atendimento humano. Sem ela, usa `settings.handoffUnavailableMessage`. */
  unavailableText: text(WHATSAPP_LIMITS.textBody).optional(),
  /** Para onde seguir sem atendimento humano. Sem destino, a automação termina. */
  unavailableNext: stepId.optional(),
});

const endStep = z.object({
  type: z.literal("end"),
  id: stepId,
  name: stepName,
  text: text(WHATSAPP_LIMITS.textBody).optional(),
});

export const flowStepSchema = z.discriminatedUnion("type", [
  messageStep,
  imageStep,
  menuStep,
  questionStep,
  handoffStep,
  endStep,
]);

export const flowSettingsSchema = z.object({
  /** Pedido explícito de atendente, reconhecido em qualquer etapa. */
  humanKeywords: keywords.default(["atendente", "humano", "falar com atendente", "falar com uma pessoa"]),
  mainMenuKeywords: keywords.default(["menu", "inicio", "menu principal"]),
  backKeywords: keywords.default(["voltar"]),
  /** Respostas inválidas seguidas antes de passar para a equipe. 2 = repete uma vez e encaminha. */
  maxInvalidAttempts: z.number().int().min(1).max(5).default(2),
  /** Respostas do cliente numa mesma sessão; acima disso, encaminha (evita conversa sem fim). */
  maxTurns: z.number().int().min(1).max(200).default(50),
  invalidMessage: text(WHATSAPP_LIMITS.textBody).default("Não entendi sua resposta. Escolha uma das opções abaixo."),
  handoffMessage: text(WHATSAPP_LIMITS.textBody).default(
    "Certo! Vou encaminhar sua conversa para a nossa equipe. Em breve alguém responde por aqui.",
  ),
  handoffUnavailableMessage: text(WHATSAPP_LIMITS.textBody).default(
    "No momento não temos atendimento humano por este canal.",
  ),
  backLabel: text(WHATSAPP_LIMITS.listRowTitle).default("Voltar"),
  mainMenuLabel: text(WHATSAPP_LIMITS.listRowTitle).default("Menu principal"),
});

const baseDefinitionSchema = z.object({
  schemaVersion: z.literal(FLOW_SCHEMA_VERSION),
  entryStepId: stepId,
  /** Menu de "Menu principal" e do atalho por palavra. Sem ele, os dois ficam desligados. */
  mainMenuStepId: stepId.optional(),
  settings: flowSettingsSchema.prefault({}),
  steps: z.array(flowStepSchema).min(1).max(ENGINE_LIMITS.steps),
});

export const flowDefinitionSchema = baseDefinitionSchema.superRefine((definition, ctx) => {
  for (const issue of graphIssues(definition)) {
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path, params: { kind: issue.kind, ...issue.params } });
  }
});

export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
export type FlowDefinitionInput = z.input<typeof flowDefinitionSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type FlowStepInput = z.input<typeof flowStepSchema>;
export type MenuStep = Extract<FlowStep, { type: "menu" }>;
export type QuestionStep = Extract<FlowStep, { type: "question" }>;
export type HandoffStep = Extract<FlowStep, { type: "handoff" }>;
export type FlowSettings = FlowDefinition["settings"];
export type ImageStep = Extract<FlowStep, { type: "image" }>;

/**
 * Tipo de cada regra do grafo, para quem precisa explicar o problema com outras
 * palavras (o editor) sem reescrever a regra.
 */
export type GraphIssueKind =
  | "duplicate_step"
  | "entry_missing"
  | "main_menu_not_menu"
  | "missing_target"
  | "image_source"
  | "min_over_max"
  | "duplicate_option"
  | "duplicate_title"
  | "too_many_rows"
  | "main_menu_required"
  | "no_pause_cycle";

export type GraphIssue = {
  kind: GraphIssueKind;
  message: string;
  path: (string | number)[];
  params?: Record<string, string | number>;
};

/** Linhas de navegação que um menu mostra além das opções. */
export function navigationRowsOf(menu: Pick<MenuStep, "id" | "showBack" | "showMainMenu">, mainMenuStepId?: string): {
  back: boolean;
  main: boolean;
} {
  const isMain = menu.id === mainMenuStepId;
  return { back: menu.showBack && !isMain, main: menu.showMainMenu && !isMain && mainMenuStepId !== undefined };
}

/** Destinos de uma etapa (para a validação do grafo). */
export function targetsOf(step: FlowStep): { id: string; path: (string | number)[] }[] {
  switch (step.type) {
    case "message":
    case "image":
    case "question":
      return [{ id: step.next, path: ["next"] }];
    case "menu":
      return step.options.map((option, index) => ({ id: option.next, path: ["options", index, "next"] }));
    case "handoff":
      return step.unavailableNext ? [{ id: step.unavailableNext, path: ["unavailableNext"] }] : [];
    case "end":
      return [];
  }
}

/**
 * Regras que o Zod não expressa por campo: referências entre etapas, ids únicos,
 * limite de linhas da lista e ciclos sem pausa (etapas que se seguem sem esperar
 * o cliente, voltando a si mesmas — o motor nunca pararia de enviar).
 */
function graphIssues(definition: z.infer<typeof baseDefinitionSchema>): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map<string, FlowStep>();
  definition.steps.forEach((step, index) => {
    if (byId.has(step.id)) issues.push({ kind: "duplicate_step", message: `etapa duplicada: ${step.id}`, path: ["steps", index, "id"] });
    else byId.set(step.id, step);
  });

  if (!byId.has(definition.entryStepId)) {
    issues.push({ kind: "entry_missing", message: `etapa inicial inexistente: ${definition.entryStepId}`, path: ["entryStepId"] });
  }
  if (definition.mainMenuStepId !== undefined && byId.get(definition.mainMenuStepId)?.type !== "menu") {
    issues.push({ kind: "main_menu_not_menu", message: "o menu principal precisa ser uma etapa de menu", path: ["mainMenuStepId"] });
  }

  definition.steps.forEach((step, index) => {
    for (const target of targetsOf(step)) {
      if (!byId.has(target.id)) {
        issues.push({ kind: "missing_target", message: `destino inexistente: ${target.id}`, path: ["steps", index, ...target.path] });
      }
    }
    if (step.type === "image" && (step.url === undefined) === (step.mediaId === undefined)) {
      issues.push({ kind: "image_source", message: "imagem: informe um link ou uma imagem enviada (só um)", path: ["steps", index, "mediaId"] });
    }
    if (step.type === "question" && step.minLength > step.maxLength) {
      issues.push({ kind: "min_over_max", message: "tamanho mínimo maior que o máximo", path: ["steps", index, "minLength"] });
    }
    if (step.type !== "menu") return;
    const ids = new Set<string>();
    const titles = new Set<string>();
    step.options.forEach((option, optionIndex) => {
      if (ids.has(option.id)) {
        issues.push({ kind: "duplicate_option", message: `opção duplicada: ${option.id}`, path: ["steps", index, "options", optionIndex, "id"] });
      }
      ids.add(option.id);
      const title = normalizeText(option.title);
      if (titles.has(title)) {
        issues.push({
          kind: "duplicate_title",
          message: `título de opção repetido: ${option.title}`,
          path: ["steps", index, "options", optionIndex, "title"],
        });
      }
      titles.add(title);
    });
    const nav = navigationRowsOf(step, definition.mainMenuStepId);
    const rows = step.options.length + Number(nav.back) + Number(nav.main);
    if (rows > 10) {
      issues.push({
        kind: "too_many_rows",
        message: `o menu ${step.id} tem ${rows} linhas; o WhatsApp aceita até 10 (opções + navegação)`,
        path: ["steps", index, "options"],
        params: { rows },
      });
    }
    if (step.showMainMenu && definition.mainMenuStepId === undefined) {
      issues.push({ kind: "main_menu_required", message: "\"Menu principal\" exige mainMenuStepId", path: ["steps", index, "showMainMenu"] });
    }
  });

  // Ciclo só de mensagens/imagens: nenhuma etapa espera o cliente.
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const step = byId.get(id);
    if (!step || (step.type !== "message" && step.type !== "image")) return false;
    if (state.get(id) === "visiting") return true;
    if (state.get(id) === "done") return false;
    state.set(id, "visiting");
    const cyclic = visit(step.next);
    state.set(id, "done");
    return cyclic;
  };
  definition.steps.forEach((step, index) => {
    if (state.has(step.id)) return;
    if (visit(step.id)) {
      issues.push({
        kind: "no_pause_cycle",
        message: `ciclo sem pausa a partir de ${step.id}: nenhuma etapa espera o cliente`,
        path: ["steps", index],
      });
    }
  });

  return issues;
}

/**
 * As mesmas regras do grafo, sobre um rascunho que ainda não passa por campo
 * (o Zod não roda o `superRefine` enquanto há campo inválido). O editor mostra
 * assim, de uma vez, um destino excluído e um texto em branco. O rascunho deve
 * ter as listas e marcações dos menus preenchidas (o editor as completa).
 */
export function draftGraphIssues(draft: FlowDefinitionInput): GraphIssue[] {
  return graphIssues(draft as z.infer<typeof baseDefinitionSchema>);
}

/** Ids das imagens enviadas pelo painel (`mediaId`) usadas pelo fluxo, sem repetição. */
export function flowMediaIds(definition: FlowDefinition): string[] {
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (step.type === "image" && step.mediaId !== undefined) ids.add(step.mediaId);
  }
  return [...ids];
}

export type DefinitionValidation =
  | { ok: true; definition: FlowDefinition }
  | { ok: false; issues: { path: string; message: string }[] };

/** Valida (e completa com os valores padrão) uma definição vinda do editor, de fixture ou do banco. */
export function parseFlowDefinition(input: unknown): DefinitionValidation {
  const result = flowDefinitionSchema.safeParse(input);
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}

/**
 * Forma mínima de um RASCUNHO. O editor grava trabalho incompleto (opção ainda
 * sem destino, texto em branco); só a publicação exige `flowDefinitionSchema`
 * inteiro. Isto não é outra validação do fluxo: confere apenas que é uma
 * definição v1 que o editor consegue abrir de novo.
 */
export const draftDefinitionSchema = z.looseObject({
  schemaVersion: z.literal(FLOW_SCHEMA_VERSION),
  entryStepId: z.string().max(64),
  mainMenuStepId: z.string().max(64).optional(),
  settings: z.looseObject({}).optional(),
  steps: z
    .array(
      z.looseObject({
        type: z.enum(["message", "image", "menu", "question", "handoff", "end"]),
        id: stepId,
      }),
    )
    .max(ENGINE_LIMITS.steps),
});

export type FlowDraft = z.infer<typeof draftDefinitionSchema>;

export function parseFlowDraft(input: unknown): { ok: true; draft: FlowDraft } | { ok: false } {
  const result = draftDefinitionSchema.safeParse(input);
  return result.success ? { ok: true, draft: result.data } : { ok: false };
}

export type FlowWarning = { kind: "unreachable"; stepId: string };

/**
 * Avisos de um fluxo VÁLIDO que não impedem publicar: etapas que nenhum caminho
 * alcança a partir do início (nem pelo menu principal, que o cliente abre por
 * palavra). Ficam no fluxo sem efeito — quase sempre esquecimento.
 */
export function flowWarnings(definition: FlowDefinition): FlowWarning[] {
  const byId = new Map(definition.steps.map((step) => [step.id, step]));
  const reached = new Set<string>();
  const pending = [definition.entryStepId, ...(definition.mainMenuStepId ? [definition.mainMenuStepId] : [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const step = byId.get(id);
    if (!step || reached.has(id)) continue;
    reached.add(id);
    for (const target of targetsOf(step)) pending.push(target.id);
  }
  return definition.steps.filter((step) => !reached.has(step.id)).map((step) => ({ kind: "unreachable", stepId: step.id }));
}
