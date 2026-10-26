import "server-only";

import { sqlStateOf, withOrganizationTransaction, type OrganizationContext } from "@/lib/db";
import type { MemberRole, MemberStatus } from "@/lib/types/database";

import type { OrganizationMemberRow } from "./queries";

/**
 * Consultas de membros sobre o PostgreSQL próprio (Entrega 4) — PARALELAS a
 * `queries.ts` (Supabase), que continua sendo a usada pelas rotas até a
 * Entrega 5. Só leitura: gestão de membros não faz parte desta etapa (ver a
 * pendência de regras de administração em docs/DATABASE.md).
 */

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
