import { cn } from "@/lib/utils/cn";
import type { ConversationListPage, ConversationStatusFilter } from "@/modules/conversations/types";

import type { ConversationDetailState } from "../_lib/types";
import { ConversationDetailPanel } from "./conversation-detail";
import { ConversationList } from "./conversation-list";

/**
 * Layout master-detail da caixa de conversas.
 *
 * Desktop (`md:` e acima): lista e detalhe lado a lado, sempre visíveis,
 * cada painel com sua própria área de rolagem dentro de uma altura fixa da
 * viewport — o padrão comum de aplicações de chat.
 *
 * Mobile: só um painel por vez, decidido por `selectedId` (vindo da URL, não
 * de estado React) — lista quando nada está selecionado, detalhe quando
 * está. Sem altura forçada: a página rola normalmente, mais robusto contra
 * as variações de altura de viewport do navegador mobile.
 */
export function ConversationsShell({
  listPage,
  selectedId,
  detailState,
  status,
  cursor,
}: {
  listPage: ConversationListPage;
  selectedId: string | null;
  detailState: ConversationDetailState;
  status: ConversationStatusFilter | undefined;
  cursor: string | undefined;
}) {
  const showList = selectedId === null;

  return (
    <div
      className={cn(
        "grid grid-cols-1 overflow-hidden rounded-lg border border-line bg-surface",
        "md:h-[calc(100vh-13rem)] md:min-h-[480px] md:grid-cols-[22rem_1fr]",
      )}
    >
      <div
        className={cn(
          "min-h-0 flex-col border-line md:flex md:border-r",
          showList ? "flex" : "hidden",
        )}
      >
        <ConversationList
          items={listPage.items}
          nextCursor={listPage.nextCursor}
          selectedId={selectedId}
          status={status}
          cursor={cursor}
        />
      </div>
      <div className={cn("min-h-0 flex-col md:flex", showList ? "hidden" : "flex")}>
        <ConversationDetailPanel state={detailState} status={status} cursor={cursor} />
      </div>
    </div>
  );
}
