import Link from "next/link";

import { conversationStatusFilterLabel } from "@/lib/labels";
import { cn } from "@/lib/utils/cn";
import type { ConversationStatusFilter } from "@/modules/conversations/types";

import { buildConversationsHref } from "../_lib/href";

const FILTER_OPTIONS: Array<ConversationStatusFilter | undefined> = [
  undefined,
  "open",
  "bot",
  "waiting",
  "human",
  "resolved",
];

/**
 * Filtro de status como links simples (sem JS) — mudar de aba navega para a
 * mesma rota (lista, ou a conversa aberta) com `status` atualizado na URL e
 * `cursor` da lista descartado (a paginação de um filtro não vale para
 * outro).
 */
export function StatusFilterTabs({
  active,
  selectedId,
}: {
  active: ConversationStatusFilter | undefined;
  selectedId: string | null;
}) {
  return (
    <div
      role="group"
      aria-label="Filtrar conversas por status"
      className="flex flex-wrap gap-1.5"
    >
      {FILTER_OPTIONS.map((status) => {
        const isActive = status === active;
        return (
          <Link
            key={status ?? "all"}
            href={buildConversationsHref({ conversationId: selectedId ?? undefined, status })}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              isActive
                ? "border-gold/40 bg-gold/10 text-gold-soft"
                : "border-line text-muted hover:border-line-strong hover:text-foreground",
            )}
          >
            {status ? conversationStatusFilterLabel[status] : "Todas"}
          </Link>
        );
      })}
    </div>
  );
}
