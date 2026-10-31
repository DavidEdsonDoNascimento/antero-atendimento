import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { OrganizationContext } from "@/lib/db";
import { IdentityUnavailableError } from "@/lib/identity/errors";
import { getValidatedSession } from "@/lib/identity/session";
import type { MemberRole, Organization, Profile } from "@/lib/types/database";
import {
  getActiveContext as loadActiveContext,
  getSuspendedOrganizations as loadSuspendedOrganizations,
} from "@/modules/organizations/sql-queries";
import { getOwnProfile } from "@/modules/users/sql-queries";

/**
 * Data Access Layer (DAL).
 *
 * Centraliza a verificação de sessão e a resolução da organização ativa.
 * Todas as páginas e ações autenticadas devem passar por aqui — nunca confie em
 * checagens apenas na UI ou no proxy. As funções usam `cache()` do React para
 * deduplicar consultas dentro de uma mesma renderização.
 *
 * Identidade: sessão do Better Auth conferida NO BANCO a cada requisição
 * (`getValidatedSession`, sem cache em cookie) — o `userId` sai só daqui.
 * Autorização: vínculo ativo em `organization_members` + RLS, pelas consultas
 * SQL (`withUserTransaction`/`withOrganizationTransaction`). Identidade ou
 * banco indisponível → erro (página de erro), nunca acesso.
 */

/** Usuário de uma sessão validada no servidor. */
export type SessionUser = { id: string; email: string };

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getValidatedSession(await headers());
  return session ? { id: session.userId, email: session.email } : null;
});

export const requireUser = cache(async (): Promise<SessionUser> => {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
});

export const getProfile = cache(async (): Promise<Profile | null> => {
  const user = await requireUser();
  return getOwnProfile({ userId: user.id });
});

export type ActiveContext = {
  userId: string;
  profile: Profile;
  organization: Organization;
  role: MemberRole;
};

/**
 * Resolve o contexto ativo do usuário: perfil + organização + papel.
 * Regra preservada do MVP: a associação ATIVA mais antiga (desempate por id)
 * em organização ATIVA; vínculos desativados, convites e organizações suspensas
 * não contam. Retorna `null` quando o usuário não tem nenhuma. Não há seletor: nada da URL, cookie ou
 * formulário escolhe a organização.
 */
export const getActiveContext = cache(
  async (): Promise<ActiveContext | null> => {
    const user = await requireUser();
    return loadActiveContext({ userId: user.id });
  },
);

/** Organizações suspensas em que o usuário da sessão tem vínculo ativo. */
export const getSuspendedOrganizations = cache(async () => {
  const user = await requireUser();
  return loadSuspendedOrganizations({ userId: user.id });
});

export const requireActiveContext = cache(async (): Promise<ActiveContext> => {
  const context = await getActiveContext();
  if (!context) {
    const suspended = await getSuspendedOrganizations();
    redirect(suspended.length > 0 ? "/organizacao-suspensa" : "/sem-organizacao");
  }
  return context;
});

/** `{ userId, organizationId }` para as consultas SQL da organização ativa. */
export function organizationContextOf(context: ActiveContext): OrganizationContext {
  return { userId: context.userId, organizationId: context.organization.id };
}

export const requirePlatformAdmin = cache(async (): Promise<Profile> => {
  const profile = await getProfile();
  if (!profile?.is_platform_admin) redirect("/visao-geral");
  return profile;
});

/**
 * Telas de login/recuperação: quem já tem sessão VÁLIDA vai para a
 * plataforma. O proxy não faz isso só pelo cookie — um cookie revogado ou
 * expirado criaria um ciclo /login ↔ /visao-geral. Com a identidade fora do
 * ar, a tela é exibida (o envio do formulário responde "indisponível").
 */
export async function redirectIfAuthenticated(): Promise<void> {
  let user: SessionUser | null = null;
  try {
    user = await getSessionUser();
  } catch (error) {
    if (!(error instanceof IdentityUnavailableError)) throw error;
  }
  if (user) redirect("/visao-geral");
}
