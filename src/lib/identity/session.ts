import "server-only";

import { APIError } from "better-auth";
import { z } from "zod";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { getIdentityAuth, type IdentityAuth } from "./auth.ts";
import { IdentityUnavailableError } from "./errors.ts";

/**
 * Sessão validada no servidor — a ÚNICA origem aceitável do `userId` que vai
 * para `withUserTransaction`/`withOrganizationTransaction`. O id é o mesmo
 * UUID de `public.profiles.id` (gatilho `handle_new_user`).
 *
 * Fluxo previsto para a Entrega 5B (DAL):
 *   session = await getValidatedSession(await headers())     → null: /login
 *   context = await getActiveContext({ userId: session.userId })
 *                                       (modules/organizations/sql-queries)
 *                                                            → null: /sem-organizacao
 *   withOrganizationTransaction({ userId, organizationId: context.organization.id }, …)
 */
export type ValidatedSession = {
  userId: string;
  sessionId: string;
  email: string;
  expiresAt: Date;
};

const uuidSchema = z.uuid();

/**
 * Lê o cookie de sessão de `headers` e confere a sessão no banco (sem cache
 * em cookie: logout e revogação valem na hora).
 *
 * - sem cookie, cookie adulterado/expirado ou sessão revogada → `null`;
 * - banco/identidade indisponível → `IdentityUnavailableError` (o chamador
 *   nega o acesso; nunca é tratado como sessão válida).
 */
export async function getValidatedSession(
  headers: Headers,
  auth: IdentityAuth = getIdentityAuth(),
): Promise<ValidatedSession | null> {
  let result: Awaited<ReturnType<IdentityAuth["api"]["getSession"]>>;
  try {
    result = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 401) return null;
    throw new IdentityUnavailableError({ cause: error });
  }
  if (!result) return null;
  const { user, session } = result;
  // Defesa em profundidade: o id precisa ser o UUID que o resto do banco usa.
  if (!uuidSchema.safeParse(user.id).success || session.userId !== user.id) return null;
  return { userId: user.id, sessionId: session.id, email: user.email, expiresAt: session.expiresAt };
}

/**
 * Encerra a sessão do cookie em `headers` (apaga a linha em `auth.sessions`)
 * e devolve os cabeçalhos `Set-Cookie` que limpam o cookie no navegador.
 */
export async function signOutSession(headers: Headers, auth: IdentityAuth = getIdentityAuth()): Promise<Headers> {
  try {
    const { headers: responseHeaders } = await auth.api.signOut({ headers, returnHeaders: true });
    return responseHeaders;
  } catch (error) {
    if (error instanceof APIError && error.statusCode < 500) return new Headers();
    throw new IdentityUnavailableError({ cause: error });
  }
}
