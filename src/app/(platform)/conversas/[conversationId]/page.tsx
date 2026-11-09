import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { organizationContextOf, requireModule } from "@/lib/auth/dal";
import { getConversationAutomation } from "@/modules/automations/sql-queries";
import { getConversationDetail, listConversationEvents } from "@/modules/conversations/sql-queries";
import { parseConversationStatusFilter, parseCursorParam } from "@/modules/conversations/search-params";

import { AutoRefresh } from "../_components/auto-refresh";
import { ConversationsShell } from "../_components/conversations-shell";
import { SimulatorLink } from "../_components/simulator-link";
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
  const active = await requireModule("atendimento");
  const context = organizationContextOf(active);
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
    loadConversationList(context, status, listCursor),
    getConversationDetail(context, conversationId),
  ]);

  const [messages, events, automation] = detail
    ? await Promise.all([
        loadConversationMessages(context, conversationId, messagesCursor),
        listConversationEvents(context, conversationId),
        getConversationAutomation(context, conversationId),
      ])
    : [null, null, null];
  const detailState: ConversationDetailState =
    detail && messages && events
      ? { kind: "found", detail, messages, events, automation, viewer: { userId: active.userId, role: active.role } }
      : { kind: "not-found" };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Conversas"
        description="Caixa de entrada de atendimento."
        actions={<SimulatorLink />}
      />
      <AutoRefresh />
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
