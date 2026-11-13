import type { ConversationAutomation } from "@/modules/automations/sql-queries";
import type { AttendanceViewer } from "@/modules/conversations/attendance";
import type {
  ConversationDetail,
  ConversationEventItem,
  MessageHistoryPage,
} from "@/modules/conversations/types";

/**
 * Estado do painel de detalhe da caixa de conversas — representa
 * explicitamente as três situações possíveis, para que a UI nunca precise
 * inferir "não selecionada" a partir de `detail == null` (que também
 * representa "não encontrada").
 */
export type ConversationDetailState =
  | { kind: "none" }
  | { kind: "not-found" }
  | {
      kind: "found";
      detail: ConversationDetail;
      messages: MessageHistoryPage;
      events: ConversationEventItem[];
      /** Última sessão de automação, com os dados coletados; nula se a automação nunca atuou. */
      automation: ConversationAutomation | null;
      /** Quem está vendo (sessão + papel na organização ativa): só orienta quais botões mostrar. */
      viewer: AttendanceViewer;
    };
