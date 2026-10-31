import "server-only";

import { z } from "zod";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { AccessDeniedError, ModuleDisabledError } from "./errors.ts";
import { withUserTransaction } from "./transaction.ts";
import type { DbTransaction } from "./types";
import type { OrganizationModule } from "../types/database";

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

/**
 * `withOrganizationTransaction` + confirmação, na mesma transação e pela mesma
 * função das políticas (`public.has_module`), de que o módulo está habilitado.
 * A decisão vale para o estado do banco neste instante, não para o que foi lido
 * antes da ação. Sem vínculo → `AccessDeniedError`; com vínculo, módulo
 * desabilitado → `ModuleDisabledError`, ambos antes de o callback rodar.
 */
export async function withModuleTransaction<T>(
  context: OrganizationContext,
  module: OrganizationModule,
  callback: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return withOrganizationTransaction(context, async (tx) => {
    const { rows } = await tx.query<{ allowed: boolean }>(
      "SELECT public.has_module($1::uuid, $2::public.organization_module) AS allowed",
      [context.organizationId, module],
    );
    if (rows[0]?.allowed !== true) throw new ModuleDisabledError();
    return callback(tx);
  });
}
