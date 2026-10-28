import "server-only";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { getAppPool } from "./pool.ts";

/**
 * Prontidão do banco da APLICAÇÃO (`antero_app`), para `/api/health/ready`.
 *
 * Não lê dados de negócio: só confere que o pool conecta (a conexão nova já
 * passa pela verificação de papel do pool) e que o papel tem `SELECT` em
 * `public.organization_members` — o que também falha se as migrations ainda
 * não foram aplicadas (`has_table_privilege` erra em relação inexistente).
 * Por isso a RLS não entra em jogo e nada é contornado.
 */
export async function pingAppDatabase(): Promise<void> {
  const { rows } = await getAppPool().query<{ ok: boolean }>(
    "select has_table_privilege(current_user, 'public.organization_members', 'select') as ok",
  );
  if (rows[0]?.ok !== true) {
    throw new Error("antero_app sem acesso ao schema esperado (migrations pendentes?)");
  }
}
