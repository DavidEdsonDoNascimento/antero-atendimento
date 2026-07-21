import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { WhatsappAccount } from "@/lib/types/database";

/**
 * Retorna a conta de WhatsApp principal da organização (a mais antiga).
 * No MVP cada organização tem no máximo uma conta.
 */
export async function getPrimaryWhatsappAccount(
  organizationId: string,
): Promise<WhatsappAccount | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("whatsapp_accounts")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Falha ao carregar conta de WhatsApp: ${error.message}`);
  }

  return data;
}
