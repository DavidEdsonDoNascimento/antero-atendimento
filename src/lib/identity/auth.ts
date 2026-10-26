import "server-only";

import { betterAuth } from "better-auth";
import type pg from "pg";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { parseIdentityConfig, type IdentityConfig } from "./config.ts";
import { createSmtpMailer, type IdentityMailer } from "./mailer.ts";
import { buildIdentityAuthOptions, type IdentityLogSink } from "./options.ts";
import { createIdentityPool } from "./pool.ts";

/**
 * Instância do Better Auth sobre o PostgreSQL próprio (`antero_auth`).
 *
 * Entrega 5A: ainda NÃO está ligada a nenhuma rota, página, action ou ao
 * proxy — o login da aplicação continua no Supabase. A Entrega 5B monta
 * `getIdentityAuth().handler` em `app/api/auth/[...all]/route.ts` e troca o
 * DAL (ver docs/AUTH.md).
 *
 * Better Auth responde QUEM é o usuário; quais organizações e dados ele
 * acessa continua sendo decidido por `organization_members` + RLS
 * (`withOrganizationTransaction`). Estar autenticado não concede nada.
 */
export function createIdentityAuth(input: {
  config: IdentityConfig;
  pool: pg.Pool;
  mailer: IdentityMailer;
  logSink?: IdentityLogSink;
}) {
  return betterAuth(buildIdentityAuthOptions(input));
}

export type IdentityAuth = ReturnType<typeof createIdentityAuth>;

type IdentityState = {
  auth: IdentityAuth;
  pool: pg.Pool;
  mailer: IdentityMailer;
};

const GLOBAL_KEY = "__anteroIdentity";
const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: IdentityState };

/**
 * Instância única do processo, criada na primeira utilização a partir das
 * variáveis de ambiente do servidor (validadas) e guardada em `globalThis`
 * para o hot reload do `next dev` não abrir pools novos a cada recompilação.
 */
export function getIdentityAuth(): IdentityAuth {
  if (!holder[GLOBAL_KEY]) {
    const config = parseIdentityConfig(process.env);
    const pool = createIdentityPool(config.database);
    const mailer = createSmtpMailer(config.mail);
    holder[GLOBAL_KEY] = { auth: createIdentityAuth({ config, pool, mailer }), pool, mailer };
  }
  return holder[GLOBAL_KEY].auth;
}

/** Encerra o pool e o SMTP da identidade (shutdown controlado / testes). */
export async function closeIdentity(): Promise<void> {
  const state = holder[GLOBAL_KEY];
  if (!state) return;
  delete holder[GLOBAL_KEY];
  state.mailer.close();
  await state.pool.end();
}
