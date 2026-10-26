import "server-only";

import { z } from "zod";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { AccessDeniedError } from "./errors.ts";
import { withUserTransaction } from "./transaction.ts";
import type { DbTransaction } from "./types";

/**
 * Identidade + organização de uma requisição. Os dois valores precisam vir
 * do servidor: `userId` de uma sessão validada e `organizationId` da
 * associação ativa desse usuário (DAL: sessão Better Auth +
 * `getActiveContext`). Nunca de parâmetro, cookie ou corpo enviados pelo
 * navegador — um UUID não prova nada.
 */
export type OrganizationContext = {
  userId: string;
  organizationId: string;
};

const organizationIdSchema = z.uuid();

/**
 * `withUserTransaction` + confirmação, DENTRO da mesma transação, de que o
 * usuário tem vínculo ATIVO com a organização (`public.is_org_member`, a
 * mesma função das políticas de RLS). Sem vínculo → `AccessDeniedError`
 * antes de o callback rodar.
 *
 * Não substitui a RLS nem o filtro explícito por `organization_id` nas
 * consultas: transforma "contexto inválido" em erro, em vez de listas vazias
 * que se confundiriam com "não há dados".
 */
export async function withOrganizationTransaction<T>(
  context: OrganizationContext,
  callback: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (!organizationIdSchema.safeParse(context?.organizationId).success) {
    throw new AccessDeniedError();
  }
  const { organizationId } = context;
  return withUserTransaction(context.userId, async (tx) => {
    const { rows } = await tx.query<{ allowed: boolean }>(
      "SELECT public.is_org_member($1::uuid) AS allowed",
      [organizationId],
    );
    if (rows[0]?.allowed !== true) throw new AccessDeniedError();
    return callback(tx);
  });
}
