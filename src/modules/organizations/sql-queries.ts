import "server-only";

import { AccessDeniedError, sqlStateOf, withUserTransaction } from "@/lib/db";
import type { ActiveContext } from "@/lib/auth/dal";
import type { MemberRole, Organization, OrganizationStatus, Profile } from "@/lib/types/database";

/**
 * Consultas de organização sobre o PostgreSQL próprio (Entrega 4; usadas
 * pelo DAL e pelas rotas desde a Entrega 5B — `queries.ts` é o legado
 * Supabase, sem uso). O `userId` precisa vir de uma sessão validada no
 * servidor.
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

/**
 * Suspende ou reativa uma organização — só administrador da plataforma. A
 * autorização é da função `public.set_organization_status` (0006), conferida
 * contra a identidade da transação; quem não é administrador recebe
 * `AccessDeniedError`.
 */
export async function setOrganizationStatus(context: {
  userId: string;
  organizationId: string;
  status: OrganizationStatus;
}): Promise<OrganizationStatus> {
  try {
    return await withUserTransaction(context?.userId, async (tx) => {
      const { rows } = await tx.query<{ status: OrganizationStatus }>(
        "SELECT public.set_organization_status($1::uuid, $2::public.organization_status) AS status",
        [context.organizationId, context.status],
      );
      return rows[0].status;
    });
  } catch (error) {
    if (sqlStateOf(error) === "42501") throw new AccessDeniedError();
    throw queryFailure("Falha ao alterar a situação da organização", error);
  }
}

export type SuspendedOrganization = { id: string; name: string };

/**
 * Organizações suspensas em que o usuário tem vínculo ativo, mais antigas
 * primeiro. A RLS esconde essas linhas do membro: é esta função que permite
 * distinguir "organização suspensa" de "sem vínculo" (`/organizacao-suspensa`).
 */
export async function getSuspendedOrganizations(context: { userId: string }): Promise<SuspendedOrganization[]> {
  try {
    return await withUserTransaction(context?.userId, async (tx) => {
      const { rows } = await tx.query<SuspendedOrganization>(
        `SELECT s.organization_id AS id, s.organization_name AS name
         FROM public.current_user_suspended_organizations() s`,
      );
      return rows;
    });
  } catch (error) {
    throw queryFailure("Falha ao carregar organizações suspensas", error);
  }
}

type ActiveMembershipRow = Organization & { role: MemberRole };

/**
 * Contexto ativo do usuário (perfil + organização + papel): a associação
 * ATIVA mais antiga (`created_at`, desempate por `id`) em organização ATIVA;
 * `null` sem perfil ou sem associação assim. O filtro de status é explícito
 * porque a RLS deixa o administrador da plataforma ler organizações e vínculos
 * de qualquer situação. É daqui que o DAL (`lib/auth/dal.ts#getActiveContext`) tira o
 * `organizationId` do `OrganizationContext` — nunca do navegador.
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
           WHERE m.user_id = $1::uuid AND m.status = 'active' AND o.status = 'active'
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
