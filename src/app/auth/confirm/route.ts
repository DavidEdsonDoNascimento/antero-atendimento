import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Confirma tokens enviados por e-mail (recuperação de senha, confirmação de
 * conta). O link do e-mail aponta para cá com `token_hash` e `type`; após
 * verificar, a sessão é estabelecida via cookies e o usuário é redirecionado.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const nextParam = searchParams.get("next") ?? "/visao-geral";

  // Evita open redirect: só aceitamos caminhos internos.
  const next = nextParam.startsWith("/") ? nextParam : "/visao-geral";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      redirect(next);
    }
  }

  redirect("/login?erro=link");
}
