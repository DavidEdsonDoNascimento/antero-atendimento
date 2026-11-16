// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import type { OutboundAction } from "./actions.ts";
import type { FlowDefinition } from "./definition.ts";
import { advance, startSession, type EndReason, type EngineContext, type EngineInput, type SessionState } from "./engine.ts";

// Prévia do editor (E3B): uma conversa inteira só em memória, pelo MESMO motor
// da execução real (`startSession`/`advance`). Lógica pura: não grava
// mensagem, sessão nem conversa — não há banco nem rede aqui.

export type PreviewEntry =
  | { from: "customer"; text: string }
  | { from: "bot"; action: OutboundAction }
  | { from: "system"; status: "handed_off" | "completed" | "failed"; reason: EndReason | null };

export type PreviewConversation = {
  /** `idle`: o cliente ainda não escreveu. Os demais são o estado da sessão do motor. */
  status: "idle" | "active" | "handed_off" | "completed" | "failed";
  state: SessionState | null;
  entries: PreviewEntry[];
};

export const EMPTY_PREVIEW: PreviewConversation = { status: "idle", state: null, entries: [] };

export function previewIsOpen(conversation: PreviewConversation): boolean {
  return conversation.status === "idle" || conversation.status === "active";
}

/**
 * O cliente responde. `shown` é o que aparece no balão do cliente (o título da
 * opção tocada, numa escolha de lista). Conversa já encerrada não muda.
 */
export function previewReply(
  definition: FlowDefinition,
  conversation: PreviewConversation,
  input: EngineInput,
  shown: string,
  context: EngineContext,
): PreviewConversation {
  if (!previewIsOpen(conversation)) return conversation;
  const result =
    conversation.status === "idle" || conversation.state === null
      ? startSession(definition, input, context)
      : advance(definition, conversation.state, input, context);
  const entries: PreviewEntry[] = [
    ...conversation.entries,
    { from: "customer", text: shown },
    ...result.outputs.map((action) => ({ from: "bot" as const, action })),
  ];
  if (result.status !== "active") entries.push({ from: "system", status: result.status, reason: result.reason });
  return { status: result.status, state: result.state, entries };
}
