import "server-only";

import { AccessDeniedError, sqlStateOf, withUserTransaction } from "@/lib/db";
import type { ActiveContext } from "@/lib/auth/dal";
import type { MemberRole, Organization, Profile } from "@/lib/types/database";

/**
 * Consultas de organização sobre o PostgreSQL próprio (Entrega 4) —
 * PARALELAS a `queries.ts` (Supabase) e ao `getActiveContext` de
 * `lib/auth/dal.ts`, que continuam sendo os usados pelas rotas até a
 * Entrega 5. O `userId` precisa vir de uma sessão validada no servidor.
 *
 * Colunas sempre explícitas (nunca `*`): uma coluna nova na tabela não passa
 * a sair daqui sem revisão.
 */

const ORGANIZATION_COLUMNS = "o.id, o.name, o.slug, o.status, o.created_at, o.updated_at";

function queryFailure(prefix: string, error: unknown): unknown {
  if (sqlStateOf(error) === undefined) return error;
  return new Error(`${prefix}: ${(error as Error).message}`, { cause: error });
}

/**
 * Todas as organizações, mais recentes primeiro — só para administrador da
 * plataforma. Equivale a `queries.ts#listAllOrganizations` na página
 * `/admin` (protegida por `requirePlatformAdmin`), com uma diferença
 * deliberada: aqui o papel é conferido no banco (`public.is_platform_admin`)
 * e quem não é administrador recebe `AccessDeniedError`, em vez das próprias
 * organizações que a RLS deixaria ver.
 */
export async function listAllOrganizations(context: { userId: string }): Promise<Organization[]> {
  try {
    return await withUserTransaction(context?.userId, async (tx) => {
      const { rows } = await tx.query<{ allowed: boolean }>("SELECT public.is_platform_admin() AS allowed");
      if (rows[0]?.allowed !== true) throw new AccessDeniedError();
      return (
        await tx.query<Organization>(
          `SELECT ${ORGANIZATION_COLUMNS} FROM public.organizations o ORDER BY o.created_at DESC, o.id DESC`,
        )
      ).rows;
    });
  } catch (error) {
    throw queryFailure("Falha ao carregar organizações", error);
  }
}

type ActiveMembershipRow = Organization & { role: MemberRole };

/**
 * Contexto ativo do usuário (perfil + organização + papel) — mesma regra de
 * `getActiveContext` em `lib/auth/dal.ts`: a associação ATIVA mais antiga
 * (`created_at`, desempate por `id`); `null` sem perfil ou sem associação
 * ativa. É daqui que a Entrega 5 tira o `organizationId` do
 * `OrganizationContext` — nunca do navegador.
 */
export async function getActiveContext(context: { userId: string }): Promise<ActiveContext | null> {
  try {
    return await withUserTransaction(context?.userId, async (tx) => {
      const userId = context.userId;
      const profile = (
        await tx.query<Profile>(
          `SELECT p.id, p.email, p.full_name, p.is_platform_admin, p.created_at, p.updated_at
           FROM public.profiles p WHERE p.id = $1::uuid`,
          [userId],
        )
      ).rows[0];
      const membership = (
        await tx.query<ActiveMembershipRow>(
          `SELECT m.role, ${ORGANIZATION_COLUMNS}
           FROM public.organization_members m
           JOIN public.organizations o ON o.id = m.organization_id
           WHERE m.user_id = $1::uuid AND m.status = 'active'
           ORDER BY m.created_at ASC, m.id ASC
           LIMIT 1`,
          [userId],
        )
      ).rows[0];
      if (!profile || !membership) return null;

      const { role, ...organization } = membership;
      return { userId, profile, organization, role };
    });
  } catch (error) {
    throw queryFailure("Falha ao carregar o contexto ativo", error);
  }
}
