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

const messageStep = z.object({
  type: z.literal("message"),
  id: stepId,
  text: text(WHATSAPP_LIMITS.textBody),
  next: stepId,
});

const imageStep = z.object({
  type: z.literal("image"),
  id: stepId,
  url: z
    .url({ protocol: /^https$/ })
    .max(WHATSAPP_LIMITS.imageUrl),
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

const settingsSchema = z.object({
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
  settings: settingsSchema.prefault({}),
  steps: z.array(flowStepSchema).min(1).max(ENGINE_LIMITS.steps),
});

export const flowDefinitionSchema = baseDefinitionSchema.superRefine((definition, ctx) => {
  for (const issue of graphIssues(definition)) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
});

export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
export type FlowDefinitionInput = z.input<typeof flowDefinitionSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type MenuStep = Extract<FlowStep, { type: "menu" }>;
export type QuestionStep = Extract<FlowStep, { type: "question" }>;
export type HandoffStep = Extract<FlowStep, { type: "handoff" }>;
export type FlowSettings = FlowDefinition["settings"];

type GraphIssue = { message: string; path: (string | number)[] };

/** Linhas de navegação que um menu mostra além das opções. */
export function navigationRowsOf(menu: Pick<MenuStep, "id" | "showBack" | "showMainMenu">, mainMenuStepId?: string): {
  back: boolean;
  main: boolean;
} {
  const isMain = menu.id === mainMenuStepId;
  return { back: menu.showBack && !isMain, main: menu.showMainMenu && !isMain && mainMenuStepId !== undefined };
}

/** Destinos de uma etapa (para a validação do grafo). */
function targetsOf(step: FlowStep): { id: string; path: (string | number)[] }[] {
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
    if (byId.has(step.id)) issues.push({ message: `etapa duplicada: ${step.id}`, path: ["steps", index, "id"] });
    else byId.set(step.id, step);
  });

  if (!byId.has(definition.entryStepId)) {
    issues.push({ message: `etapa inicial inexistente: ${definition.entryStepId}`, path: ["entryStepId"] });
  }
  if (definition.mainMenuStepId !== undefined && byId.get(definition.mainMenuStepId)?.type !== "menu") {
    issues.push({ message: "o menu principal precisa ser uma etapa de menu", path: ["mainMenuStepId"] });
  }

  definition.steps.forEach((step, index) => {
    for (const target of targetsOf(step)) {
      if (!byId.has(target.id)) {
        issues.push({ message: `destino inexistente: ${target.id}`, path: ["steps", index, ...target.path] });
      }
    }
    if (step.type === "question" && step.minLength > step.maxLength) {
      issues.push({ message: "tamanho mínimo maior que o máximo", path: ["steps", index, "minLength"] });
    }
    if (step.type !== "menu") return;
    const ids = new Set<string>();
    const titles = new Set<string>();
    step.options.forEach((option, optionIndex) => {
      if (ids.has(option.id)) {
        issues.push({ message: `opção duplicada: ${option.id}`, path: ["steps", index, "options", optionIndex, "id"] });
      }
      ids.add(option.id);
      const title = normalizeText(option.title);
      if (titles.has(title)) {
        issues.push({ message: `título de opção repetido: ${option.title}`, path: ["steps", index, "options", optionIndex, "title"] });
      }
      titles.add(title);
    });
    const nav = navigationRowsOf(step, definition.mainMenuStepId);
    const rows = step.options.length + Number(nav.back) + Number(nav.main);
    if (rows > 10) {
      issues.push({
        message: `o menu ${step.id} tem ${rows} linhas; o WhatsApp aceita até 10 (opções + navegação)`,
        path: ["steps", index, "options"],
      });
    }
    if (step.showMainMenu && definition.mainMenuStepId === undefined) {
      issues.push({ message: "\"Menu principal\" exige mainMenuStepId", path: ["steps", index, "showMainMenu"] });
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
      issues.push({ message: `ciclo sem pausa a partir de ${step.id}: nenhuma etapa espera o cliente`, path: ["steps", index] });
    }
  });

  return issues;
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
