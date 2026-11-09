import "server-only";

import { AccessDeniedError, sqlStateOf, withUserTransaction } from "@/lib/db";
import type { ConversationStatus } from "@/lib/types/database";

/**
 * Consultas do simulador de mensagens (só desenvolvimento e testes — ver
 * `lib/dev-environment.ts`). Não há caminho de escrita próprio: a mensagem
 * entra por `public.ingest_inbound_message` (0005), a mesma porta que valida
 * canal `development` conectado, owner/admin ativo da organização dona do
 * canal e organização ativa. Nada aqui recebe organização do navegador: ela é
 * sempre derivada do canal, dentro da transação.
 */

export type SimulatorChannel = {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  organization_id: string;
  organization_name: string;
};

// Canais em que o usuário da transação pode simular: development, conectados,
// de organizações em que ele é owner/admin ativo (is_org_admin já exige
// organização ativa). A RLS de whatsapp_accounts/organizations também filtra.
const CHANNELS_SQL = `
SELECT w.id, w.display_name, w.phone_number, o.id AS organization_id, o.name AS organization_name
FROM public.whatsapp_accounts w
JOIN public.organizations o ON o.id = w.organization_id
WHERE w.provider = 'development'
  AND w.status = 'connected'
  AND public.is_org_admin(w.organization_id)`;

function queryFailure(prefix: string, error: unknown): unknown {
  if (sqlStateOf(error) === undefined) return error;
  return new Error(`${prefix}: ${(error as Error).message}`, { cause: error });
}

export async function listSimulatorChannels(context: { userId: string }): Promise<SimulatorChannel[]> {
  try {
    return await withUserTransaction(context?.userId, async (tx) =>
      (await tx.query<SimulatorChannel>(`${CHANNELS_SQL} ORDER BY o.name, w.created_at, w.id`)).rows,
    );
  } catch (error) {
    throw queryFailure("Falha ao carregar os canais do simulador", error);
  }
}

export type SimulatorContact = {
  contact_id: string;
  name: string | null;
  phone_number: string;
  conversation_id: string;
  status: ConversationStatus;
};

/** Contatos com conversa neste canal, mais recentes primeiro (atalho para "selecionar contato"). */
export async function listSimulatorContacts(
  context: { userId: string },
  channelId: string,
): Promise<SimulatorContact[]> {
  try {
    return await withUserTransaction(context?.userId, async (tx) => {
      const channel = (await tx.query<SimulatorChannel>(`${CHANNELS_SQL} AND w.id = $1::uuid`, [channelId])).rows[0];
      if (!channel) return [];
      return (
        await tx.query<SimulatorContact>(
          `SELECT ct.id AS contact_id, ct.name, ct.phone_number, c.id AS conversation_id, c.status
           FROM public.conversations c
           JOIN public.contacts ct ON ct.organization_id = c.organization_id AND ct.id = c.contact_id
           WHERE c.organization_id = $1::uuid AND c.whatsapp_account_id = $2::uuid
           ORDER BY c.last_message_at DESC, c.id DESC
           LIMIT 20`,
          [channel.organization_id, channel.id],
        )
      ).rows;
    });
  } catch (error) {
    throw queryFailure("Falha ao carregar os contatos do simulador", error);
  }
}

export type SimulatedInbound = {
  organization_id: string;
  contact_id: string;
  conversation_id: string;
  message_id: string;
  created: boolean;
  duplicate: boolean;
  reopened: boolean;
};

/** Recusa da ingestão (`antero_ingest: <motivo>: …` em 0005), para a tela explicar. */
export class SimulatorIngestError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: ErrorOptions) {
    super(`Mensagem simulada recusada: ${reason}.`, options);
    this.name = "SimulatorIngestError";
    this.reason = reason;
  }
}

/** "Cliente envia mensagem": ingestão real, como owner/admin da organização do canal. */
export async function simulateInboundMessage(
  context: { userId: string },
  input: { channelId: string; phoneNumber: string; contactName: string | null; content: string; externalMessageId: string },
): Promise<SimulatedInbound> {
  try {
    return await withUserTransaction(context?.userId, async (tx) => {
      const { rows } = await tx.query<SimulatedInbound>(
        `SELECT organization_id, contact_id, conversation_id, message_id, created, duplicate, reopened
         FROM public.ingest_inbound_message(
           p_whatsapp_account_id => $1::uuid,
           p_phone_number => $2::text,
           p_content => $3::text,
           p_external_message_id => $4::text,
           p_contact_name => $5::text)`,
        [input.channelId, input.phoneNumber, input.content, input.externalMessageId, input.contactName],
      );
      return rows[0];
    });
  } catch (error) {
    const sqlState = sqlStateOf(error);
    if (sqlState === "42501" || sqlState === "28000") throw new AccessDeniedError();
    const reason = /antero_ingest: ([a-z_]+):/.exec((error as Error)?.message ?? "")?.[1];
    if (reason) throw new SimulatorIngestError(reason, { cause: error });
    throw queryFailure("Falha ao simular a mensagem", error);
  }
}
