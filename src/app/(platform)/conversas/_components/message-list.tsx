import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";
import { IconConversations } from "@/components/ui/icons";
import { messageSenderLabel } from "@/lib/labels";
import { cn } from "@/lib/utils/cn";
import type { ConversationStatusFilter, MessageHistoryPage } from "@/modules/conversations/types";

import { formatMessageTime } from "../_lib/format";
import { buildConversationsHref } from "../_lib/href";

export function MessageList({
  conversationId,
  page,
  status,
  cursor,
}: {
  conversationId: string;
  page: MessageHistoryPage;
  status: ConversationStatusFilter | undefined;
  cursor: string | undefined;
}) {
  if (page.items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<IconConversations className="size-6" />}
          title="Nenhuma mensagem ainda"
          description="Esta conversa ainda não tem mensagens registradas."
        />
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-3 p-4 md:overflow-y-auto">
      {page.nextCursor && (
        <div className="pb-1 text-center">
          <Link
            href={buildConversationsHref({
              conversationId,
              status,
              cursor,
              messagesCursor: page.nextCursor,
            })}
            className="text-xs font-medium text-gold-soft hover:text-gold"
          >
            Carregar mensagens anteriores
          </Link>
        </div>
      )}

      {page.items.map((message) => {
        const isOutbound = message.direction === "outbound";
        return (
          <div key={message.id} className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[80%] rounded-lg border px-3 py-2 text-sm",
                isOutbound
                  ? "border-gold/20 bg-gold/10 text-foreground"
                  : "border-line bg-surface-2 text-foreground",
              )}
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              <p
                className={cn(
                  "mt-1 flex items-center gap-1.5 text-[11px] text-muted-2",
                  isOutbound && "justify-end",
                )}
              >
                <span>{messageSenderLabel[message.sender]}</span>
                <span aria-hidden>·</span>
                <span>{formatMessageTime(message.createdAt)}</span>
                {message.deliveryStatus === "failed" && (
                  <span className="font-medium text-red-400">Falhou</span>
                )}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
