import { randomUUID } from "node:crypto";

import type { WhatsappProvider } from "../../lib/types/database";

// Lógica pura (sem I/O, sem segredo) — sem `import "server-only"`, testável com
// `node --test`. Quem chama é `modules/conversations/sql-commands.ts`, fora de
// qualquer transação do banco.

/**
 * Envio de mensagens pelo canal da conversa. As regras de atendimento (quem
 * responde, janela, estado) ficam no banco; o provedor só entrega o texto e
 * devolve o id externo. Trocar o simulado pela Cloud API (E2C) é implementar
 * `MessagingProvider` para `cloud_api` em `providerFor`.
 */
export type OutboundTextMessage = {
  /** Canal da conversa; `externalAccountId` será o `phone_number_id` da Meta. */
  channel: { id: string; provider: WhatsappProvider; externalAccountId: string | null };
  /** Telefone do contato em E.164. */
  to: string;
  text: string;
  /** Mesma chave do pedido (`messages.client_message_id`): o provedor real a usa para não duplicar. */
  idempotencyKey: string;
};

export type SendResult =
  | { ok: true; externalMessageId: string }
  | { ok: false; reason: string };

export interface MessagingProvider {
  readonly provider: WhatsappProvider;
  /** `true` quando nada sai do servidor: a interface identifica as mensagens como simuladas. */
  readonly simulated: boolean;
  sendText(message: OutboundTextMessage): Promise<SendResult>;
}

/** Prefixo dos ids externos do provedor simulado: nunca se confunde com um `wamid` da Meta. */
export const SIMULATED_MESSAGE_ID_PREFIX = "sim-out-";

/**
 * Provedor dos canais `development`: não faz chamada externa nem usa token.
 * Considera o envio aceito e devolve um id externo marcado como simulado.
 */
export const simulatedProvider: MessagingProvider = {
  provider: "development",
  simulated: true,
  async sendText() {
    return { ok: true, externalMessageId: `${SIMULATED_MESSAGE_ID_PREFIX}${randomUUID()}` };
  },
};

/** O canal não tem provedor disponível nesta versão (Cloud API chega na E2C). */
export class ProviderUnavailableError extends Error {
  constructor(provider: WhatsappProvider) {
    super(`Envio indisponível para canais ${provider} nesta versão.`);
    this.name = "ProviderUnavailableError";
  }
}

/** Provedor do canal, ou `ProviderUnavailableError` se ainda não existir. */
export function providerFor(provider: WhatsappProvider): MessagingProvider {
  if (provider === "development") return simulatedProvider;
  throw new ProviderUnavailableError(provider);
}
