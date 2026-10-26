import "server-only";

import { sqlStateOf, withOrganizationTransaction, withUserTransaction, type OrganizationContext } from "@/lib/db";
import type { MemberRole, MemberStatus, Profile } from "@/lib/types/database";

import type { OrganizationMemberRow } from "./types";

/**
 * Consultas de usuários e membros sobre o PostgreSQL próprio (usadas pelas
 * rotas desde a Entrega 5B; `queries.ts` é o legado Supabase, sem uso). Só
 * leitura: gestão de membros não faz parte desta etapa (ver a pendência de
 * regras de administração em docs/DATABASE.md).
 */

/**
 * Perfil do PRÓPRIO usuário da sessão (`null` se ainda não existir). O
 * `userId` precisa vir de uma sessão validada no servidor; a RLS de
 * `profiles` também restringe o que ele enxerga.
 */
export async function getOwnProfile(context: { userId: string }): Promise<Profile | null> {
  try {
    return await withUserTransaction(context?.userId, async (tx) => {
      const { rows } = await tx.query<Profile>(
        `SELECT p.id, p.email, p.full_name, p.is_platform_admin, p.created_at, p.updated_at
         FROM public.profiles p WHERE p.id = $1::uuid`,
        [context.userId],
      );
      return rows[0] ?? null;
    });
  } catch (error) {
    if (sqlStateOf(error) === undefined) throw error;
    throw new Error(`Falha ao carregar perfil: ${(error as Error).message}`, { cause: error });
  }
}

type MemberSqlRow = {
  id: string;
  role: MemberRole;
  status: MemberStatus;
  created_at: string;
  profile_id: string | null;
  profile_full_name: string | null;
  profile_email: string | null;
};

/**
 * Membros da organização com nome e e-mail do perfil, mais antigos
 * primeiro — mesmo contrato de `queries.ts#listOrganizationMembers`.
 * `profile` é `null` quando a RLS de `profiles` o oculta (ex.: membro
 * desativado visto por um colega: `shares_org_with` exige vínculo ativo dos
 * dois lados), exatamente como o embed do PostgREST. Nada de `auth.*`.
 */
export async function listOrganizationMembers(context: OrganizationContext): Promise<OrganizationMemberRow[]> {
  let rows: MemberSqlRow[];
  try {
    rows = await withOrganizationTransaction(context, async (tx) =>
      (
        await tx.query<MemberSqlRow>(
          `SELECT m.id, m.role, m.status, m.created_at,
                  p.id AS profile_id, p.full_name AS profile_full_name, p.email AS profile_email
           FROM public.organization_members m
           LEFT JOIN public.profiles p ON p.id = m.user_id
           WHERE m.organization_id = $1::uuid
           ORDER BY m.created_at ASC, m.id ASC`,
          [context.organizationId],
        )
      ).rows,
    );
  } catch (error) {
    if (sqlStateOf(error) === undefined) throw error;
    throw new Error(`Falha ao carregar membros: ${(error as Error).message}`, { cause: error });
  }

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
    profile:
      row.profile_id === null
        ? null
        : { id: row.profile_id, full_name: row.profile_full_name, email: row.profile_email as string },
  }));
}
