import type { ConversationDetail, MessageHistoryPage } from "@/modules/conversations/types";

/**
 * Estado do painel de detalhe da caixa de conversas — representa
 * explicitamente as três situações possíveis, para que a UI nunca precise
 * inferir "não selecionada" a partir de `detail == null` (que também
 * representa "não encontrada").
 */
export type ConversationDetailState =
  | { kind: "none" }
  | { kind: "not-found" }
  | { kind: "found"; detail: ConversationDetail; messages: MessageHistoryPage };
