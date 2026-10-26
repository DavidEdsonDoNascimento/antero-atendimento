import "server-only";

import { sqlStateOf, withOrganizationTransaction, type OrganizationContext } from "@/lib/db";
import type { WhatsappAccount } from "@/lib/types/database";

/**
 * Consultas de WhatsApp sobre o PostgreSQL próprio (Entrega 4; usadas pelas
 * rotas desde a Entrega 5B — `queries.ts` é o legado Supabase, sem uso, a
 * remover na Entrega 6). Colunas explícitas (nunca `*`): se a tabela ganhar credenciais
 * da Meta, elas não passam a sair daqui sem revisão.
 */

/**
 * Conta de WhatsApp principal da organização (a mais antiga; desempate por
 * `id`) ou `null` — mesmo contrato de `queries.ts#getPrimaryWhatsappAccount`.
 */
export async function getPrimaryWhatsappAccount(context: OrganizationContext): Promise<WhatsappAccount | null> {
  try {
    return await withOrganizationTransaction(context, async (tx) => {
      const { rows } = await tx.query<WhatsappAccount>(
        `SELECT w.id, w.organization_id, w.provider, w.external_account_id, w.phone_number,
                w.display_name, w.status, w.created_at, w.updated_at
         FROM public.whatsapp_accounts w
         WHERE w.organization_id = $1::uuid
         ORDER BY w.created_at ASC, w.id ASC
         LIMIT 1`,
        [context.organizationId],
      );
      return rows[0] ?? null;
    });
  } catch (error) {
    if (sqlStateOf(error) === undefined) throw error;
    throw new Error(`Falha ao carregar conta de WhatsApp: ${(error as Error).message}`, { cause: error });
  }
}
