import "server-only";

import { createClient } from "@/lib/supabase/server";

import type { OrganizationMemberRow } from "./types";

export type { OrganizationMemberRow };

/**
 * Lista os membros de uma organização com nome e e-mail (do perfil).
 * A visibilidade é garantida pelas políticas de RLS.
 */
export async function listOrganizationMembers(
  organizationId: string,
): Promise<OrganizationMemberRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_members")
    .select("id, role, status, created_at, profile:profiles(id, full_name, email)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .returns<OrganizationMemberRow[]>();

  if (error) {
    throw new Error(`Falha ao carregar membros: ${error.message}`);
  }

  return data ?? [];
}
