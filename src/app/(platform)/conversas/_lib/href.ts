import type { ConversationStatusFilter } from "@/modules/conversations/types";

/**
 * Monta a URL da caixa de conversas preservando filtro e paginação —
 * centralizado aqui para que toda origem de link (linha da lista, abas de
 * filtro, "carregar mais", botão voltar no mobile) construa a mesma forma
 * de URL, com a mesma codificação.
 */
export function buildConversationsHref(options: {
  conversationId?: string;
  status?: ConversationStatusFilter;
  /** Cursor da PÁGINA DA LISTA de conversas (parâmetro `cursor`). */
  cursor?: string;
  /** Cursor do HISTÓRICO DE MENSAGENS da conversa selecionada (parâmetro `antes`). */
  messagesCursor?: string;
}): string {
  const base = options.conversationId
    ? `/conversas/${options.conversationId}`
    : "/conversas";

  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.messagesCursor) params.set("antes", options.messagesCursor);

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
