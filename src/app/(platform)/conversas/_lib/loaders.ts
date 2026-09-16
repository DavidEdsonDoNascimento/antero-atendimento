import { InvalidCursorError } from "@/modules/conversations/errors";
import { MESSAGES_PAGE_LIMIT } from "@/modules/conversations/pagination";
import { listConversationMessages, listConversations } from "@/modules/conversations/queries";
import type {
  ConversationListPage,
  ConversationStatusFilter,
  MessageHistoryPage,
} from "@/modules/conversations/types";

/**
 * Busca a lista de conversas tolerando um cursor inválido/adulterado na URL
 * (favorito antigo, cursor de um filtro diferente): em vez de propagar
 * `InvalidCursorError` para a tela de erro genérica, cai de volta para a
 * primeira página do filtro atual. O cursor é opaco para esta camada —
 * nunca é decodificado aqui, só repassado para a DAL.
 */
export async function loadConversationList(
  organizationId: string,
  status: ConversationStatusFilter | undefined,
  cursor: string | undefined,
): Promise<ConversationListPage> {
  try {
    return await listConversations(organizationId, { status, cursor });
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      return listConversations(organizationId, { status });
    }
    throw error;
  }
}

const EMPTY_MESSAGE_PAGE: MessageHistoryPage = { items: [], nextCursor: null };

/**
 * Busca uma página do histórico de mensagens, com a mesma tolerância a
 * cursor inválido. Pede o teto de página (`MESSAGES_PAGE_LIMIT.max`, já
 * suportado pela DAL) em vez do padrão — mais contexto por carregamento
 * numa conversa, sem OFFSET e sem descarregar o histórico inteiro (o teto
 * continua sendo aplicado pela DAL).
 *
 * Assume que a existência/acesso à conversa já foi confirmado pelo chamador
 * via `getConversationDetail`. Um retorno `null` aqui só pode acontecer por
 * uma condição de corrida (conversa removida entre as duas chamadas) —
 * tratada como histórico vazio, não como erro.
 */
export async function loadConversationMessages(
  organizationId: string,
  conversationId: string,
  cursor: string | undefined,
): Promise<MessageHistoryPage> {
  try {
    const page = await listConversationMessages(organizationId, conversationId, {
      cursor,
      limit: MESSAGES_PAGE_LIMIT.max,
    });
    return page ?? EMPTY_MESSAGE_PAGE;
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      const page = await listConversationMessages(organizationId, conversationId, {
        limit: MESSAGES_PAGE_LIMIT.max,
      });
      return page ?? EMPTY_MESSAGE_PAGE;
    }
    throw error;
  }
}
