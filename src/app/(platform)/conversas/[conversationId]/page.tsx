import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { requireActiveContext } from "@/lib/auth/dal";
import { getConversationDetail } from "@/modules/conversations/queries";
import { parseConversationStatusFilter, parseCursorParam } from "@/modules/conversations/search-params";

import { ConversationsShell } from "../_components/conversations-shell";
import { loadConversationList, loadConversationMessages } from "../_lib/loaders";
import type { ConversationDetailState } from "../_lib/types";

export const metadata: Metadata = { title: "Conversas" };

type ConversaDetalhePageProps = {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{
    status?: string | string[];
    cursor?: string | string[];
    antes?: string | string[];
  }>;
};

export default async function ConversaDetalhePage({
  params,
  searchParams,
}: ConversaDetalhePageProps) {
  const { organization } = await requireActiveContext();
  const { conversationId } = await params;
  const sp = await searchParams;
  const status = parseConversationStatusFilter(sp.status);
  const listCursor = parseCursorParam(sp.cursor);
  const messagesCursor = parseCursorParam(sp.antes);

  // Lista e detalhe são buscas independentes — corridas em paralelo em vez
  // de sequenciais. As mensagens só são buscadas depois, e só se a conversa
  // existir e for acessível a esta organização (evita uma consulta inútil
  // para um ID inválido/de outro tenant).
  const [listPage, detail] = await Promise.all([
    loadConversationList(organization.id, status, listCursor),
    getConversationDetail(organization.id, conversationId),
  ]);

  const detailState: ConversationDetailState = detail
    ? {
        kind: "found",
        detail,
        messages: await loadConversationMessages(organization.id, conversationId, messagesCursor),
      }
    : { kind: "not-found" };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Conversas"
        description="Caixa de entrada de atendimento — somente leitura."
      />
      <ConversationsShell
        listPage={listPage}
        selectedId={conversationId}
        detailState={detailState}
        status={status}
        cursor={listCursor}
      />
    </div>
  );
}
