// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import type { ListRow, OutboundAction } from "./actions.ts";
import {
  BACK_OPTION_ID,
  MAIN_MENU_OPTION_ID,
  navigationRowsOf,
  type FlowDefinition,
  type FlowStep,
  type HandoffStep,
  type MenuStep,
  type QuestionStep,
} from "./definition.ts";
import { ENGINE_LIMITS } from "./limits.ts";
import { containsKeyword, matchesExactly, normalizeText } from "./text.ts";

// Lógica pura e determinística: sem I/O, sem relógio, sem aleatoriedade. Não
// conhece Next.js, banco nem WhatsApp. A mesma entrada produz sempre a mesma
// saída — é o que permite a prévia do editor (E3B), o simulador e a produção
// usarem exatamente o mesmo código.

/** Estado de uma sessão, gravado em `automation_sessions.state`. */
export type SessionState = {
  /** Etapa que espera a resposta do cliente (menu ou pergunta). */
  stepId: string;
  /** Último menu mostrado: destino de "voltar" a partir de uma pergunta. */
  currentMenuId: string | null;
  /** Menus anteriores, para "voltar ao menu anterior". */
  menuStack: string[];
  /** Respostas inválidas seguidas na etapa atual. */
  invalidAttempts: number;
  /** Respostas do cliente nesta sessão. */
  turns: number;
  /** Dados coletados pelas perguntas, com o rótulo que o atendente vê. */
  answers: Record<string, { label: string; value: string }>;
};

/** Resposta do cliente. `selection` é a linha escolhida numa lista interativa (id estável). */
export type EngineInput = { type: "text"; text: string } | { type: "selection"; optionId: string };

export type EngineContext = {
  /** A organização tem atendimento humano (módulo Atendimento) para receber o encaminhamento. */
  humanHandoffAvailable: boolean;
};

export type SessionOutcome = "active" | "handed_off" | "completed" | "failed";

export type EndReason =
  | "flow_end"
  | "handoff_step"
  | "human_requested"
  | "invalid_attempts"
  | "turn_limit"
  | "handoff_unavailable"
  | "step_limit"
  | "output_limit"
  | "invalid_state";

export type EngineResult = {
  status: SessionOutcome;
  /** Estado a gravar. Em sessão encerrada, guarda as respostas coletadas. */
  state: SessionState;
  outputs: OutboundAction[];
  /** Motivo do encerramento; nulo enquanto a sessão continua. */
  reason: EndReason | null;
};

// Sem "parameter properties": o Node executa os testes removendo só os tipos.
class Turn {
  readonly definition: FlowDefinition;
  readonly context: EngineContext;
  state: SessionState;
  readonly outputs: OutboundAction[] = [];
  autoSteps = 0;

  constructor(definition: FlowDefinition, context: EngineContext, state: SessionState) {
    this.definition = definition;
    this.context = context;
    this.state = state;
  }

  step(id: string): FlowStep | undefined {
    return this.definition.steps.find((step) => step.id === id);
  }

  emit(action: OutboundAction): boolean {
    if (this.outputs.length >= ENGINE_LIMITS.outputsPerTurn) return false;
    this.outputs.push(action);
    return true;
  }

  finish(status: SessionOutcome, reason: EndReason | null): EngineResult {
    return { status, state: this.state, outputs: this.outputs, reason };
  }

  /** Falha segura: não envia nada além do que já saiu e passa a conversa adiante. */
  fail(reason: EndReason): EngineResult {
    return { status: "failed", state: this.state, outputs: [], reason };
  }
}

function initialState(definition: FlowDefinition): SessionState {
  return {
    stepId: definition.entryStepId,
    currentMenuId: null,
    menuStack: [],
    invalidAttempts: 0,
    turns: 1,
    answers: {},
  };
}

/** Linhas da lista de um menu: opções e navegação, nessa ordem (é a numeração aceita como resposta). */
export function menuRows(definition: FlowDefinition, menu: MenuStep): ListRow[] {
  const rows: ListRow[] = menu.options.map((option) => ({
    id: option.id,
    title: option.title,
    ...(option.description ? { description: option.description } : {}),
  }));
  const nav = navigationRowsOf(menu, definition.mainMenuStepId);
  if (nav.back) rows.push({ id: BACK_OPTION_ID, title: definition.settings.backLabel });
  if (nav.main) rows.push({ id: MAIN_MENU_OPTION_ID, title: definition.settings.mainMenuLabel });
  return rows;
}

function menuAction(definition: FlowDefinition, menu: MenuStep): OutboundAction {
  return {
    type: "list",
    ...(menu.header ? { header: menu.header } : {}),
    body: menu.text,
    ...(menu.footer ? { footer: menu.footer } : {}),
    button: menu.button,
    sections: [{ ...(menu.sectionTitle ? { title: menu.sectionTitle } : {}), rows: menuRows(definition, menu) }],
  };
}

/** Mostra um menu e atualiza a pilha de "voltar". */
function presentMenu(turn: Turn, menu: MenuStep, { fromBack = false } = {}): EngineResult {
  const { state, definition } = turn;
  let stack = [...state.menuStack];
  if (menu.id === definition.mainMenuStepId) {
    stack = [];
  } else if (!fromBack) {
    const index = stack.indexOf(menu.id);
    if (index >= 0) stack = stack.slice(0, index);
    else if (state.currentMenuId && state.currentMenuId !== menu.id) stack.push(state.currentMenuId);
  }
  turn.state = {
    ...state,
    stepId: menu.id,
    currentMenuId: menu.id,
    menuStack: stack.slice(-ENGINE_LIMITS.menuStack),
  };
  if (!turn.emit(menuAction(definition, menu))) return turn.fail("output_limit");
  return turn.finish("active", null);
}

/**
 * Percorre etapas a partir de `stepId` até uma que espere o cliente (menu,
 * pergunta) ou que encerre (encaminhamento, conclusão). Mensagens e imagens
 * seguem direto. Há um teto de etapas por resposta, além da validação de ciclos
 * na publicação.
 */
function runFrom(turn: Turn, stepId: string): EngineResult {
  let id = stepId;
  for (;;) {
    if (++turn.autoSteps > ENGINE_LIMITS.autoStepsPerTurn) return turn.fail("step_limit");
    const step = turn.step(id);
    if (!step) return turn.fail("invalid_state");
    turn.state = { ...turn.state, invalidAttempts: 0 };
    switch (step.type) {
      case "message":
        if (!turn.emit({ type: "text", text: step.text })) return turn.fail("output_limit");
        id = step.next;
        continue;
      case "image":
        if (!turn.emit({ type: "image", url: step.url, ...(step.caption ? { caption: step.caption } : {}) })) {
          return turn.fail("output_limit");
        }
        id = step.next;
        continue;
      case "menu":
        return presentMenu(turn, step);
      case "question":
        turn.state = { ...turn.state, stepId: step.id };
        if (!turn.emit({ type: "text", text: step.text })) return turn.fail("output_limit");
        return turn.finish("active", null);
      case "handoff":
        return handoff(turn, "handoff_step", step);
      case "end":
        if (step.text && !turn.emit({ type: "text", text: step.text })) return turn.fail("output_limit");
        return turn.finish("completed", "flow_end");
    }
  }
}

/** Mostra de novo a etapa que espera o cliente (depois de inválida ou de "sem atendimento"). */
function repeatCurrent(turn: Turn, step: MenuStep | QuestionStep): EngineResult {
  if (step.type === "menu") {
    if (!turn.emit(menuAction(turn.definition, step))) return turn.fail("output_limit");
  } else if (!turn.emit({ type: "text", text: step.text })) {
    return turn.fail("output_limit");
  }
  return turn.finish("active", null);
}

/**
 * Passa para a equipe. Sem atendimento humano na organização, o encaminhamento
 * é impossível: avisa o cliente e segue para `unavailableNext`, volta à etapa
 * atual (pedido avulso de atendente) ou termina.
 */
function handoff(
  turn: Turn,
  reason: EndReason,
  step?: HandoffStep,
  current?: MenuStep | QuestionStep,
): EngineResult {
  const { settings } = turn.definition;
  if (turn.context.humanHandoffAvailable) {
    if (!turn.emit({ type: "text", text: step?.text ?? settings.handoffMessage })) return turn.fail("output_limit");
    return turn.finish("handed_off", reason);
  }
  if (!turn.emit({ type: "text", text: step?.unavailableText ?? settings.handoffUnavailableMessage })) {
    return turn.fail("output_limit");
  }
  if (step?.unavailableNext) return runFrom(turn, step.unavailableNext);
  if (current && reason === "human_requested") return repeatCurrent(turn, current);
  return turn.finish("completed", "handoff_unavailable");
}

function invalid(turn: Turn, step: MenuStep | QuestionStep): EngineResult {
  const attempts = turn.state.invalidAttempts + 1;
  turn.state = { ...turn.state, invalidAttempts: attempts };
  // Sem atendimento humano, repetir de novo não resolveria: `handoff` encerra.
  if (attempts >= turn.definition.settings.maxInvalidAttempts) return handoff(turn, "invalid_attempts");
  const message = step.invalidMessage ?? turn.definition.settings.invalidMessage;
  if (!turn.emit({ type: "text", text: message })) return turn.fail("output_limit");
  return repeatCurrent(turn, step);
}

function goBack(turn: Turn, step: MenuStep | QuestionStep): EngineResult {
  const { definition, state } = turn;
  let target: string | undefined;
  let stack = state.menuStack;
  if (step.type === "question") {
    target = state.currentMenuId ?? definition.mainMenuStepId;
  } else {
    target = stack.at(-1) ?? definition.mainMenuStepId;
    stack = stack.slice(0, -1);
  }
  const menu = target ? turn.step(target) : undefined;
  if (!menu || menu.type !== "menu") return invalid(turn, step);
  turn.state = { ...state, menuStack: stack, invalidAttempts: 0 };
  return presentMenu(turn, menu, { fromBack: true });
}

function goMainMenu(turn: Turn, step: MenuStep | QuestionStep): EngineResult {
  const main = turn.definition.mainMenuStepId ? turn.step(turn.definition.mainMenuStepId) : undefined;
  if (!main || main.type !== "menu") return invalid(turn, step);
  turn.state = { ...turn.state, invalidAttempts: 0 };
  return presentMenu(turn, main);
}

/** Linha escolhida: id estável (lista interativa), número mostrado, id, título ou palavra-chave. */
function selectedRow(turn: Turn, menu: MenuStep, input: EngineInput): string | undefined {
  const rows = menuRows(turn.definition, menu);
  if (input.type === "selection") return rows.find((row) => row.id === input.optionId)?.id;
  const normalized = normalizeText(input.text);
  if (normalized === "") return undefined;
  if (/^\d+$/.test(normalized)) return rows[Number(normalized) - 1]?.id;
  const byIdOrTitle = rows.find((row) => row.id === normalized || normalizeText(row.title) === normalized);
  if (byIdOrTitle) return byIdOrTitle.id;
  return menu.options.find((option) => option.keywords && matchesExactly(input.text, option.keywords))?.id;
}

function answerMenu(turn: Turn, menu: MenuStep, input: EngineInput): EngineResult {
  const rowId = selectedRow(turn, menu, input);
  if (rowId === BACK_OPTION_ID) return goBack(turn, menu);
  if (rowId === MAIN_MENU_OPTION_ID) return goMainMenu(turn, menu);
  const option = menu.options.find((candidate) => candidate.id === rowId);
  if (!option) return invalid(turn, menu);
  return runFrom(turn, option.next);
}

function answerQuestion(turn: Turn, question: QuestionStep, input: EngineInput): EngineResult {
  if (input.type !== "text") return invalid(turn, question);
  const value = input.text.trim();
  if (value.length < question.minLength || value.length > question.maxLength) return invalid(turn, question);
  turn.state = {
    ...turn.state,
    answers: { ...turn.state.answers, [question.variable]: { label: question.label, value } },
  };
  return runFrom(turn, question.next);
}

/** Pedido explícito de atendente. Em pergunta, só a palavra sozinha (a resposta livre pode conter "atendente"). */
function asksForHuman(turn: Turn, step: MenuStep | QuestionStep | null, input: EngineInput): boolean {
  if (input.type !== "text") return false;
  const keywords = turn.definition.settings.humanKeywords;
  return step?.type === "question" ? matchesExactly(input.text, keywords) : containsKeyword(input.text, keywords);
}

/**
 * Início de uma sessão, pela primeira mensagem do cliente. Se ela já for um
 * pedido de atendente, encaminha sem passar pelo fluxo; senão apresenta a etapa
 * inicial (o conteúdo da saudação não é interpretado).
 */
export function startSession(definition: FlowDefinition, input: EngineInput, context: EngineContext): EngineResult {
  const turn = new Turn(definition, context, initialState(definition));
  if (asksForHuman(turn, null, input) && context.humanHandoffAvailable) return handoff(turn, "human_requested");
  return runFrom(turn, definition.entryStepId);
}

/** Próximo passo de uma sessão ativa, a partir da resposta do cliente. */
export function advance(
  definition: FlowDefinition,
  state: SessionState,
  input: EngineInput,
  context: EngineContext,
): EngineResult {
  const turn = new Turn(definition, context, { ...state, turns: state.turns + 1 });
  const step = turn.step(state.stepId);
  if (!step || (step.type !== "menu" && step.type !== "question")) return turn.fail("invalid_state");

  if (asksForHuman(turn, step, input)) return handoff(turn, "human_requested", undefined, step);
  if (turn.state.turns > definition.settings.maxTurns) return handoff(turn, "turn_limit");

  if (input.type === "text") {
    if (matchesExactly(input.text, definition.settings.mainMenuKeywords) && definition.mainMenuStepId) {
      return goMainMenu(turn, step);
    }
    if (matchesExactly(input.text, definition.settings.backKeywords)) return goBack(turn, step);
  }

  return step.type === "menu" ? answerMenu(turn, step, input) : answerQuestion(turn, step, input);
}

/** Confere a forma de um estado lido do banco antes de entregá-lo ao motor. */
export function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.stepId === "string" &&
    (state.currentMenuId === null || typeof state.currentMenuId === "string") &&
    Array.isArray(state.menuStack) &&
    state.menuStack.every((item) => typeof item === "string") &&
    Number.isInteger(state.invalidAttempts) &&
    Number.isInteger(state.turns) &&
    typeof state.answers === "object" &&
    state.answers !== null &&
    Object.values(state.answers).every(
      (answer) =>
        typeof answer === "object" &&
        answer !== null &&
        typeof (answer as Record<string, unknown>).label === "string" &&
        typeof (answer as Record<string, unknown>).value === "string",
    )
  );
}
