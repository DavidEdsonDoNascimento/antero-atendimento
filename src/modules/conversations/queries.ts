import "server-only";

import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

// Extensão .ts explícita nas importações de VALOR (funções/constantes
// usadas em runtime) — necessária para o ESM nativo do Node resolver estes
// especificadores relativos (ver nota em cursor.ts); irrelevante para o
// build do Next.js, que resolve por bundler.
import {
  decodeConversationCursor,
  decodeMessageHistoryCursor,
  encodeConversationCursor,
  encodeMessageHistoryCursor,
} from "./cursor.ts";
import { ConversationQueryError } from "./errors.ts";
import { mapConversationDetailRow, mapConversationListRow, mapMessageRow } from "./mappers.ts";
import { CONVERSATIONS_PAGE_LIMIT, MESSAGES_PAGE_LIMIT, clampLimit } from "./pagination.ts";
import type { ConversationDetailRow, ConversationListRow, MessageHistoryRow } from "./rows";
import type {
  ConversationDetail,
  ConversationListPage,
  ListConversationMessagesParams,
  ListConversationsParams,
  MessageHistoryPage,
} from "./types";

/**
 * DAL de leitura de conversas — Ciclo 2, Etapa 4. Server-only, sem
 * dependência de UI, sem mutação. Toda função recebe `organizationId` já
 * resolvido pelo chamador via `requireActiveContext()` (mesmo padrão de
 * `modules/organizations/queries.ts`, `modules/users/queries.ts` e
 * `modules/whatsapp/queries.ts`) — nunca um valor vindo do cliente.
 *
 * Isolamento multiempresa: cada consulta filtra explicitamente por
 * `organization_id` (defesa em profundidade além da RLS), e todas as
 * relações embutidas (`contact`, `whatsapp_account`, `assigned_member`,
 * `last_message`) são alcançadas por foreign keys COMPOSTAS que já incluem
 * `organization_id` (ver 0003_atendimento.sql) — uma linha de outra
 * organização não pode aparecer embutida numa linha desta organização,
 * estruturalmente, não apenas por política de RLS.
 */

const uuidSchema = z.uuid();

function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

const CONTACT_FIELDS = "id, name, phone_number";
const CHANNEL_FIELDS = "id, display_name, phone_number";
const ASSIGNEE_FIELDS =
  "user_id, profile:profiles!organization_members_user_id_fkey(id, full_name)";

/**
 * Cliente Supabase server-side (mesmo tipo que `createClient()` resolve).
 * Usado apenas para permitir injeção de um cliente em `*WithClient` — nunca
 * exposto fora deste módulo, nunca passado a um componente.
 */
type ConversationsSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Lista paginada de conversas da organização, mais recentes primeiro.
 *
 * Ordenação: `last_message_at DESC, id DESC` — desempate determinístico por
 * UUID quando dois `last_message_at` colidem. Paginação por cursor
 * (keyset), nunca por OFFSET.
 *
 * A última mensagem de cada conversa vem embutida na MESMA consulta:
 * `messages` é relacionado via `order` + `limit(1)` escopados à tabela
 * referenciada (`{ referencedTable: "messages" }`). O PostgREST resolve
 * isso com uma sub-consulta lateral por linha pai — o corte de 1 mensagem é
 * aplicado por conversa, não sobre o resultado achatado — então não há
 * N+1: é uma única ida ao banco para a página inteira.
 *
 * `organizationId` deve vir de `requireActiveContext()` no chamador — nunca
 * de input do cliente.
 */
export async function listConversations(
  organizationId: string,
  params: ListConversationsParams = {},
): Promise<ConversationListPage> {
  const supabase = await createClient();
  return listConversationsWithClient(supabase, organizationId, params);
}

/**
 * Mesma implementação de `listConversations`, com o cliente Supabase
 * injetado em vez de criado internamente — existe só para permitir
 * validação de runtime contra um Postgres/PostgREST real (ex.: com a sessão
 * de um usuário de teste) sem duplicar a consulta. `listConversations`
 * continua sendo a única API pública que componentes/Server Actions devem
 * chamar; esta função não deve ser importada fora de testes/scripts de
 * validação.
 */
export async function listConversationsWithClient(
  supabase: ConversationsSupabaseClient,
  organizationId: string,
  params: ListConversationsParams = {},
): Promise<ConversationListPage> {
  const limit = clampLimit(params.limit, CONVERSATIONS_PAGE_LIMIT);
  const cursor = params.cursor ? decodeConversationCursor(params.cursor) : null;

  let query = supabase
    .from("conversations")
    .select(
      `
      id,
      status,
      started_at,
      last_message_at,
      contact:contacts!conversations_contact_id_fkey(${CONTACT_FIELDS}),
      whatsapp_account:whatsapp_accounts!conversations_whatsapp_account_id_fkey(${CHANNEL_FIELDS}),
      assigned_member:organization_members!conversations_assigned_user_id_fkey(${ASSIGNEE_FIELDS}),
      last_message:messages!messages_conversation_whatsapp_account_fkey(id, direction, sender_type, content, created_at)
      `,
    )
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    .order("created_at", { referencedTable: "messages", ascending: false })
    .limit(1, { referencedTable: "messages" })
    .limit(limit + 1);

  if (params.status === "open") {
    query = query.neq("status", "resolved");
  } else if (params.status) {
    query = query.eq("status", params.status);
  }

  if (cursor) {
    query = query.or(
      `last_message_at.lt.${cursor.lastMessageAt},and(last_message_at.eq.${cursor.lastMessageAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await query.returns<ConversationListRow[]>();

  if (error) {
    throw new ConversationQueryError(`Falha ao carregar conversas: ${error.message}`);
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);

  return {
    items: pageRows.map(mapConversationListRow),
    nextCursor:
      hasMore && last
        ? encodeConversationCursor({ lastMessageAt: last.last_message_at, id: last.id })
        : null,
  };
}

/**
 * Detalhe de uma conversa por ID, escopado à organização do chamador.
 *
 * ID malformado, inexistente, ou de outra organização: retorna `null` em
 * todos os três casos, indistinguível para quem chama — nunca revela se o
 * ID existe em outro tenant.
 */
export async function getConversationDetail(
  organizationId: string,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const supabase = await createClient();
  return getConversationDetailWithClient(supabase, organizationId, conversationId);
}

/** Ver nota em `listConversationsWithClient` — mesmo propósito, só para validação. */
export async function getConversationDetailWithClient(
  supabase: ConversationsSupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<ConversationDetail | null> {
  if (!isUuid(conversationId)) return null;

  const { data, error } = await supabase
    .from("conversations")
    .select(
      `
      id,
      status,
      started_at,
      last_message_at,
      assigned_at,
      resolved_at,
      contact:contacts!conversations_contact_id_fkey(${CONTACT_FIELDS}),
      whatsapp_account:whatsapp_accounts!conversations_whatsapp_account_id_fkey(${CHANNEL_FIELDS}),
      assigned_member:organization_members!conversations_assigned_user_id_fkey(${ASSIGNEE_FIELDS})
      `,
    )
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle()
    .returns<ConversationDetailRow>();

  if (error) {
    throw new ConversationQueryError(`Falha ao carregar conversa: ${error.message}`);
  }
  if (!data) return null;

  return mapConversationDetailRow(data);
}

/**
 * Histórico paginado de mensagens de uma conversa, escopado à organização
 * do chamador. Retorna `null` quando a conversa não existe, é inválida, ou
 * pertence a outra organização — mesmo contrato de not-found de
 * `getConversationDetail`. Isso é verificado ANTES de buscar mensagens: um
 * ID de conversa de outra organização nunca chega a listar nada.
 *
 * A consulta busca em ORDEM DESCENDENTE (`created_at DESC, id DESC`) com
 * `LIMIT` — a forma correta de paginar "as N mensagens mais antigas a
 * partir de um cursor" sem OFFSET (permite usar o índice
 * `messages_conversation_created_idx` tanto na primeira página quanto nas
 * seguintes). O resultado é então INVERTIDO em memória antes de retornar,
 * para a ordem cronológica (mais antiga primeiro) que uma interface de chat
 * espera renderizar de cima para baixo.
 */
export async function listConversationMessages(
  organizationId: string,
  conversationId: string,
  params: ListConversationMessagesParams = {},
): Promise<MessageHistoryPage | null> {
  const supabase = await createClient();
  return listConversationMessagesWithClient(supabase, organizationId, conversationId, params);
}

/** Ver nota em `listConversationsWithClient` — mesmo propósito, só para validação. */
export async function listConversationMessagesWithClient(
  supabase: ConversationsSupabaseClient,
  organizationId: string,
  conversationId: string,
  params: ListConversationMessagesParams = {},
): Promise<MessageHistoryPage | null> {
  if (!isUuid(conversationId)) return null;

  // Confirma que a conversa pertence a esta organização ANTES de tocar em
  // messages — permite distinguir "conversa inexistente/de outro tenant"
  // (null) de "conversa existe e não tem mensagens" ({ items: [] }). Uma
  // única consulta extra pela chave primária, não um N+1.
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();

  if (conversationError) {
    throw new ConversationQueryError(
      `Falha ao verificar conversa: ${conversationError.message}`,
    );
  }
  if (!conversation) return null;

  const limit = clampLimit(params.limit, MESSAGES_PAGE_LIMIT);
  const cursor = params.cursor ? decodeMessageHistoryCursor(params.cursor) : null;

  let query = supabase
    .from("messages")
    .select(
      "id, direction, sender_type, message_type, content, delivery_status, sender_user_id, created_at",
    )
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await query.returns<MessageHistoryRow[]>();

  if (error) {
    throw new ConversationQueryError(`Falha ao carregar mensagens: ${error.message}`);
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const pageRowsDesc = hasMore ? rows.slice(0, limit) : rows;
  const oldestLoaded = pageRowsDesc.at(-1);

  return {
    items: pageRowsDesc.map(mapMessageRow).reverse(),
    nextCursor:
      hasMore && oldestLoaded
        ? encodeMessageHistoryCursor({
            createdAt: oldestLoaded.created_at,
            id: oldestLoaded.id,
          })
        : null,
  };
}
