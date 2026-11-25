// Validação dos argumentos do cadastro de canal cloud_api
// (`scripts/whatsapp-channel.mjs`, E2B-1). Lógica pura (sem I/O), testável com
// `node --test`. O banco confere tudo de novo (0014: formato dos ids,
// Phone Number ID único, WABA de uma só organização).

export type ChannelInput = {
  organizationId: string;
  /** Phone Number ID da Meta (`metadata.phone_number_id` do webhook). */
  phoneNumberId: string;
  /** WhatsApp Business Account ID (`entry[].id` do webhook). */
  wabaId: string;
  /** Número exibido, em E.164 (só informativo). */
  displayPhone: string | null;
  displayName: string | null;
  status: "connected" | "disconnected";
};

export class ChannelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelInputError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^[0-9]{5,32}$/;
const E164 = /^\+[1-9][0-9]{1,14}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parseChannelInput(values: Record<string, string | boolean | undefined>): ChannelInput {
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string).trim() : "");
  const organizationId = text("organization").toLowerCase();
  const phoneNumberId = text("phone-number-id");
  const wabaId = text("waba-id");
  const displayPhone = text("display-phone") || null;
  const displayName = text("display-name") || null;
  const status = text("status") || "disconnected";

  if (!UUID.test(organizationId)) throw new ChannelInputError("--organization deve ser o UUID da organização.");
  if (!META_ID.test(phoneNumberId)) throw new ChannelInputError("--phone-number-id deve ser o Phone Number ID da Meta (5 a 32 dígitos).");
  if (!META_ID.test(wabaId)) throw new ChannelInputError("--waba-id deve ser o WhatsApp Business Account ID da Meta (5 a 32 dígitos).");
  if (phoneNumberId === wabaId) throw new ChannelInputError("--phone-number-id e --waba-id são identificadores diferentes na Meta.");
  if (displayPhone !== null && !E164.test(displayPhone)) {
    throw new ChannelInputError("--display-phone deve estar em E.164 (ex.: +5511912345678).");
  }
  if (displayName !== null && (displayName.length > 120 || CONTROL.test(displayName))) {
    throw new ChannelInputError("--display-name deve ter até 120 caracteres, sem caracteres de controle.");
  }
  if (status !== "connected" && status !== "disconnected") {
    throw new ChannelInputError("--status deve ser connected ou disconnected.");
  }
  return { organizationId, phoneNumberId, wabaId, displayPhone, displayName, status };
}
