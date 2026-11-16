import { withUserTransaction } from "../../src/lib/db/transaction.ts";

/** Módulos que `has_module` libera ao usuário numa organização (para provar que o admin da plataforma não recebe nenhum). */
export async function getAllowedModules(userId: string, organizationId: string): Promise<string[]> {
  return withUserTransaction(userId, async (tx) => {
    const { rows } = await tx.query<{ module: string; ok: boolean }>(
      `SELECT m AS module, public.has_module($1::uuid, m) AS ok
       FROM unnest(enum_range(NULL::public.organization_module)) AS m`,
      [organizationId],
    );
    return rows.filter((row) => row.ok).map((row) => row.module);
  });
}
