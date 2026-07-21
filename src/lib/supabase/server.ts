import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { clientEnv } from "@/lib/env/client";
import type { Database } from "@/lib/types/database";

/**
 * Cliente Supabase para uso no servidor (Server Components, Server Actions e
 * Route Handlers). A sessão é lida/gravada nos cookies da requisição.
 *
 * Continua usando a chave anônima: a segurança entre organizações é garantida
 * pelas políticas de RLS no banco, não pelo tipo de chave.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // `setAll` foi chamado a partir de um Server Component, onde não é
            // possível escrever cookies. Pode ser ignorado com segurança: o
            // `proxy.ts` é responsável por renovar a sessão nas requisições.
          }
        },
      },
    },
  );
}
