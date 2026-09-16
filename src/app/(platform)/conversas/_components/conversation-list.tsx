import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { IconConversations } from "@/components/ui/icons";
import { conversationStatusLabel, conversationStatusTone } from "@/lib/labels";
import { cn } from "@/lib/utils/cn";
import type { ConversationListItem, ConversationStatusFilter } from "@/modules/conversations/types";

import { formatLastActivity } from "../_lib/format";
import { buildConversationsHref } from "../_lib/href";
import { StatusFilterTabs } from "./status-filter-tabs";

function initialsOf(name: string | null, phoneNumber: string): string {
  const source = name?.trim() || phoneNumber;
  const parts = source.split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

function ConversationRow({
  item,
  isActive,
  status,
  cursor,
}: {
  item: ConversationListItem;
  isActive: boolean;
  status: ConversationStatusFilter | undefined;
  cursor: string | undefined;
}) {
  return (
    <Link
      href={buildConversationsHref({ conversationId: item.id, status, cursor })}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex items-start gap-3 border-b border-line px-4 py-3 transition-colors",
        isActive ? "bg-surface-2" : "hover:bg-surface-2/60",
      )}
    >
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full border border-line-strong bg-surface-3 text-xs font-semibold text-muted">
        {initialsOf(item.contact.name, item.contact.phoneNumber)}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {item.contact.name || item.contact.phoneNumber}
          </span>
          <span className="shrink-0 text-xs text-muted-2">
            {formatLastActivity(item.lastMessageAt)}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-2">{item.contact.phoneNumber}</span>
        <span className="block truncate text-sm text-muted">
          {item.lastMessage?.excerpt || "Sem mensagens"}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Badge tone={conversationStatusTone[item.status]}>
            {conversationStatusLabel[item.status]}
          </Badge>
          {item.assignee && <Badge tone="zinc">{item.assignee.fullName || "Atendente"}</Badge>}
        </span>
      </span>
    </Link>
  );
}

export function ConversationList({
  items,
  nextCursor,
  selectedId,
  status,
  cursor,
}: {
  items: ConversationListItem[];
  nextCursor: string | null;
  selectedId: string | null;
  status: ConversationStatusFilter | undefined;
  cursor: string | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-col">
      <div className="space-y-3 border-b border-line px-4 py-3">
        <StatusFilterTabs active={status} selectedId={selectedId} />
      </div>

      {items.length === 0 ? (
        <div className="flex-1 p-4">
          <EmptyState
            icon={<IconConversations className="size-6" />}
            title="Nenhuma conversa encontrada"
            description="Quando novas mensagens chegarem, elas aparecem aqui."
          />
        </div>
      ) : (
        <div className="flex-1 md:overflow-y-auto">
          {items.map((item) => (
            <ConversationRow
              key={item.id}
              item={item}
              isActive={item.id === selectedId}
              status={status}
              cursor={cursor}
            />
          ))}
          {nextCursor && (
            <div className="p-3 text-center">
              <Link
                href={buildConversationsHref({
                  conversationId: selectedId ?? undefined,
                  status,
                  cursor: nextCursor,
                })}
                className="text-xs font-medium text-gold-soft hover:text-gold"
              >
                Carregar mais
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
