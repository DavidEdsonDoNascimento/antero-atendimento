import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { IconConversations } from "@/components/ui/icons";
import { conversationStatusLabel, conversationStatusTone } from "@/lib/labels";
import type { ConversationStatusFilter } from "@/modules/conversations/types";

import { formatLastActivity } from "../_lib/format";
import { buildConversationsHref } from "../_lib/href";
import type { ConversationDetailState } from "../_lib/types";
import { MessageList } from "./message-list";

function BackToListLink({
  status,
  cursor,
}: {
  status: ConversationStatusFilter | undefined;
  cursor: string | undefined;
}) {
  return (
    <Link
      href={buildConversationsHref({ status, cursor })}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground md:hidden"
    >
      ← Voltar para a lista
    </Link>
  );
}

export function ConversationDetailPanel({
  state,
  status,
  cursor,
}: {
  state: ConversationDetailState;
  status: ConversationStatusFilter | undefined;
  cursor: string | undefined;
}) {
  if (state.kind === "none") {
    return (
      <div className="hidden flex-1 flex-col items-center justify-center p-6 md:flex">
        <EmptyState
          icon={<IconConversations className="size-6" />}
          title="Selecione uma conversa"
          description="Escolha uma conversa na lista ao lado para ver o histórico de mensagens."
        />
      </div>
    );
  }

  if (state.kind === "not-found") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        <BackToListLink status={status} cursor={cursor} />
        <EmptyState
          icon={<IconConversations className="size-6" />}
          title="Conversa não encontrada"
          description="Ela pode ter sido removida, ou você não tem acesso a ela."
        />
      </div>
    );
  }

  const { detail, messages } = state;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-line px-4 py-3">
        <BackToListLink status={status} cursor={cursor} />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {detail.contact.name || detail.contact.phoneNumber}
            </p>
            <p className="truncate text-xs text-muted-2">{detail.contact.phoneNumber}</p>
          </div>
          <Badge tone={conversationStatusTone[detail.status]}>
            {conversationStatusLabel[detail.status]}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-2">
          <span>Início: {formatLastActivity(detail.startedAt)}</span>
          <span>Última atividade: {formatLastActivity(detail.lastMessageAt)}</span>
          {detail.assignee && <span>Atendente: {detail.assignee.fullName || "Sem nome"}</span>}
          {detail.resolvedAt && <span>Resolvida em: {formatLastActivity(detail.resolvedAt)}</span>}
        </div>
      </div>

      <MessageList conversationId={detail.id} page={messages} status={status} cursor={cursor} />
    </div>
  );
}
