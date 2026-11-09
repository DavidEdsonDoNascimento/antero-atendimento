import { randomUUID } from "node:crypto";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { IconConversations } from "@/components/ui/icons";
import { conversationStatusLabel, conversationStatusTone } from "@/lib/labels";
import { attendanceActionsFor, replyWindowOf } from "@/modules/conversations/attendance";
import type { ConversationDetail, ConversationStatusFilter } from "@/modules/conversations/types";

import { formatLastActivity, formatMessageTime } from "../_lib/format";
import { buildConversationsHref } from "../_lib/href";
import type { ConversationDetailState } from "../_lib/types";
import { AttendanceControls } from "./attendance-controls";
import { AttendanceLog } from "./attendance-log";
import { MessageList } from "./message-list";
import { ReplyComposer } from "./reply-composer";

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

  const { detail, messages, events, viewer } = state;
  const actions = attendanceActionsFor({ status: detail.status, assigneeUserId: detail.assignee?.userId ?? null }, viewer);
  const simulated = detail.channelProvider === "development";

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
          <span>
            Responsável:{" "}
            <span className="text-foreground">
              {detail.assignee
                ? actions.isMine
                  ? "Você"
                  : detail.assignee.fullName || "Membro sem vínculo ativo"
                : "Ninguém"}
            </span>
          </span>
          {detail.assignedAt && <span>Assumida: {formatLastActivity(detail.assignedAt)}</span>}
          <span>Início: {formatLastActivity(detail.startedAt)}</span>
          <span>Última atividade: {formatLastActivity(detail.lastMessageAt)}</span>
          {detail.resolvedAt && <span>Resolvida em: {formatLastActivity(detail.resolvedAt)}</span>}
        </div>
        {simulated && (
          <p className="text-xs text-sky-300">
            Canal de desenvolvimento: mensagens simuladas, nada é enviado ao WhatsApp.
          </p>
        )}
        <AttendanceControls key={detail.id} conversationId={detail.id} actions={actions} />
        <AttendanceLog events={events} viewerId={viewer.userId} />
      </div>

      <MessageList
        conversationId={detail.id}
        page={messages}
        status={status}
        cursor={cursor}
        viewerId={viewer.userId}
        simulated={simulated}
      />

      {actions.canReply ? (
        <ReplyComposer
          key={detail.id}
          conversationId={detail.id}
          initialClientMessageId={randomUUID()}
          disabledReason={replyBlockedReason(detail)}
          simulated={simulated}
        />
      ) : (
        <p className="border-t border-line px-4 py-3 text-xs text-muted-2">{replyHint(detail.status, actions.canClaim)}</p>
      )}
    </div>
  );
}

/** Janela de 24 h encerrada (o banco recusa com a mesma regra, pelo relógio dele). */
function replyBlockedReason(detail: ConversationDetail): string | null {
  const window = replyWindowOf(detail.lastInboundAt);
  if (window.open) return null;
  if (!window.closedAt) {
    return "O cliente ainda não enviou mensagem nesta conversa: não há janela para resposta livre.";
  }
  return (
    `A janela de 24 horas para respostas livres encerrou em ${formatLastActivity(window.closedAt)} ` +
    `às ${formatMessageTime(window.closedAt)}. Ela reabre quando o cliente enviar uma nova mensagem.`
  );
}

function replyHint(status: ConversationDetail["status"], canClaim: boolean): string {
  if (status === "resolved") return "Atendimento resolvido. Uma nova mensagem do cliente reabre a conversa.";
  if (canClaim) return "Assuma o atendimento para responder.";
  return "Esta conversa está com outro atendente.";
}
