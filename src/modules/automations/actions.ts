// Lógica pura (sem I/O). O que o motor manda enviar, sem saber como: o
// provedor traduz cada ação para o canal (simulado hoje; Cloud API na E3C, em
// `modules/messaging/cloud-api.ts`). A interpretação de uma escolha usa o `id`
// da linha, nunca a posição em que ela foi mostrada.

export type ListRow = { id: string; title: string; description?: string };

export type OutboundAction =
  | { type: "text"; text: string }
  | { type: "image"; url: string; caption?: string }
  | {
      type: "list";
      header?: string;
      body: string;
      footer?: string;
      button: string;
      sections: { title?: string; rows: ListRow[] }[];
    };

/** Tipo de mensagem gravado em `messages.message_type` para cada ação. */
export type AutomationMessageType = "text" | "image" | "interactive";

export type AutomationMessageRecord = {
  messageType: AutomationMessageType;
  /** Texto legível no histórico da Inbox e no canal simulado. */
  content: string;
  /** A ação completa (`messages.payload`), para reenviar ou traduzir para o canal. */
  payload: OutboundAction;
};

/** Representação gravada de uma ação: o texto do histórico é derivado, o payload é a fonte. */
export function toMessageRecord(action: OutboundAction): AutomationMessageRecord {
  switch (action.type) {
    case "text":
      return { messageType: "text", content: action.text, payload: action };
    case "image":
      return { messageType: "image", content: action.caption ?? "Imagem", payload: action };
    case "list": {
      const rows = action.sections.flatMap((section) => section.rows);
      const lines = rows.map((row, index) => `${index + 1}. ${row.title}${row.description ? ` — ${row.description}` : ""}`);
      const content = [action.header, action.body, lines.join("\n"), action.footer].filter(Boolean).join("\n\n");
      return { messageType: "interactive", content, payload: action };
    }
  }
}
