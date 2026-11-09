import type { OutboundAction } from "../automations/actions";
import { WHATSAPP_LIMITS } from "../automations/limits.ts";

// Lógica pura (sem I/O, sem token). Prepara o corpo de `POST /{phone_number_id}/messages`
// da Cloud API para cada ação do motor; o transporte (HTTP, token, retentativas)
// chega com o provedor `cloud_api` (E2C/E3C). Existe agora para que os limites
// sejam conferidos — e testados sem internet — desde o motor.

export type CloudApiMessage = Record<string, unknown> & {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text" | "image" | "interactive";
};

export class CloudApiFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudApiFormatError";
  }
}

function limit(value: string | undefined, max: number, field: string): void {
  if (value !== undefined && (value.length === 0 || value.length > max)) {
    throw new CloudApiFormatError(`${field}: deve ter de 1 a ${max} caracteres`);
  }
}

/** Corpo da Cloud API para uma ação; `to` em E.164 (a API usa só dígitos). */
export function toCloudApiMessage(to: string, action: OutboundAction): CloudApiMessage {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: to.replace(/^\+/, "") } as const;
  switch (action.type) {
    case "text":
      limit(action.text, WHATSAPP_LIMITS.textBody, "texto");
      return { ...base, type: "text", text: { body: action.text, preview_url: false } };
    case "image":
      if (!/^https:\/\//.test(action.url) || action.url.length > WHATSAPP_LIMITS.imageUrl) {
        throw new CloudApiFormatError("imagem: link https de até 2000 caracteres");
      }
      limit(action.caption, WHATSAPP_LIMITS.imageCaption, "legenda");
      return { ...base, type: "image", image: { link: action.url, ...(action.caption ? { caption: action.caption } : {}) } };
    case "list": {
      limit(action.body, WHATSAPP_LIMITS.listBody, "corpo da lista");
      limit(action.header, WHATSAPP_LIMITS.listHeader, "cabeçalho");
      limit(action.footer, WHATSAPP_LIMITS.listFooter, "rodapé");
      limit(action.button, WHATSAPP_LIMITS.listButton, "botão");
      const rows = action.sections.flatMap((section) => section.rows);
      if (rows.length === 0 || rows.length > WHATSAPP_LIMITS.listRows) {
        throw new CloudApiFormatError(`lista: de 1 a ${WHATSAPP_LIMITS.listRows} linhas no total`);
      }
      if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new CloudApiFormatError("lista: ids de linha repetidos");
      if (action.sections.length > 1 && action.sections.some((section) => !section.title)) {
        throw new CloudApiFormatError("lista: com mais de uma seção, todas precisam de título");
      }
      for (const row of rows) {
        limit(row.id, WHATSAPP_LIMITS.listRowId, "id da linha");
        limit(row.title, WHATSAPP_LIMITS.listRowTitle, "título da linha");
        limit(row.description, WHATSAPP_LIMITS.listRowDescription, "descrição da linha");
      }
      for (const section of action.sections) limit(section.title, WHATSAPP_LIMITS.listSectionTitle, "título da seção");
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          ...(action.header ? { header: { type: "text", text: action.header } } : {}),
          body: { text: action.body },
          ...(action.footer ? { footer: { text: action.footer } } : {}),
          action: {
            button: action.button,
            sections: action.sections.map((section) => ({
              ...(section.title ? { title: section.title } : {}),
              rows: section.rows.map((row) => ({
                id: row.id,
                title: row.title,
                ...(row.description ? { description: row.description } : {}),
              })),
            })),
          },
        },
      };
    }
  }
}

/**
 * Resposta do cliente a uma lista (`messages[].interactive.list_reply` no
 * webhook). O motor recebe o id estável da linha, não o texto mostrado.
 */
export function selectionFromListReply(reply: { id?: unknown }): { type: "selection"; optionId: string } | null {
  return typeof reply.id === "string" && reply.id.length > 0 && reply.id.length <= WHATSAPP_LIMITS.listRowId
    ? { type: "selection", optionId: reply.id }
    : null;
}
