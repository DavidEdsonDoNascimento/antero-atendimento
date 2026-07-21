import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { clientEnv } from "@/lib/env/client";

/**
 * Proxy (equivalente ao antigo Middleware, renomeado no Next.js 16).
 *
 * Responsabilidades:
 *  1. Renovar a sessão do Supabase a cada requisição (refresh dos cookies).
 *  2. Fazer uma verificação OTIMISTA de rota — redireciona não autenticados
 *     para /login e usuários logados para fora das telas de autenticação.
 *
 * A proteção definitiva mora no DAL e nas políticas de RLS. O proxy é apenas a
 * primeira barreira, como recomenda a documentação do Next.js.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/recuperar-senha",
  "/redefinir-senha",
  "/auth",
];

// Rotas de autenticação das quais um usuário já logado deve ser redirecionado.
const AUTH_ONLY_PREFIXES = ["/login", "/recuperar-senha"];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // IMPORTANTE: não execute código entre createServerClient e getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Preserva os cookies renovados ao emitir um redirect.
  const redirectTo = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((cookie) => {
      redirect.cookies.set(cookie);
    });
    return redirect;
  };

  if (!user && !matchesPrefix(pathname, PUBLIC_PREFIXES)) {
    return redirectTo("/login");
  }

  if (user && matchesPrefix(pathname, AUTH_ONLY_PREFIXES)) {
    return redirectTo("/visao-geral");
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Executa em todas as rotas, exceto arquivos estáticos e imagens:
     * - _next/static, _next/image
     * - favicon e imagens comuns
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
