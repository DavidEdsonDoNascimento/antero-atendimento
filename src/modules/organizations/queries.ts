import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Organization } from "@/lib/types/database";

/**
 * Lista todas as organizações. Só retorna resultados para administradores da
 * plataforma (`is_platform_admin`), conforme as políticas de RLS.
 */
export async function listAllOrganizations(): Promise<Organization[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Falha ao carregar organizações: ${error.message}`);
  }

  return data ?? [];
}
