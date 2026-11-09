import { conversationEventLabel } from "@/lib/labels";
import type { ConversationEventItem } from "@/modules/conversations/types";

import { formatLastActivity, formatMessageTime } from "../_lib/format";

/** Registro de atendimento (quem assumiu, quem resolveu, quando reabriu), sem JS. */
export function AttendanceLog({ events, viewerId }: { events: ConversationEventItem[]; viewerId: string }) {
  if (events.length === 0) return null;
  return (
    <details className="text-xs text-muted-2">
      <summary className="cursor-pointer select-none hover:text-foreground">
        Registro do atendimento ({events.length})
      </summary>
      <ol className="mt-2 space-y-1">
        {events.map((event) => {
          const who = event.userId === viewerId ? "Você" : event.userFullName || "Membro sem vínculo ativo";
          // Hoje: só o horário; outros dias: "Ontem"/data + horário.
          const day = formatLastActivity(event.createdAt);
          const time = formatMessageTime(event.createdAt);
          return (
            <li key={event.id} className="flex flex-wrap gap-x-1.5">
              <span className="tabular-nums">{day === time ? time : `${day} ${time}`}</span>
              <span aria-hidden>·</span>
              <span className="text-muted">
                {event.type === "reopened"
                  ? conversationEventLabel.reopened
                  : `${event.userId ? who : "Sistema"} ${conversationEventLabel[event.type]}`}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
