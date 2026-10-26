import { NextResponse, type NextRequest } from "next/server";

import { hasSessionCookie, isPublicPath } from "@/lib/auth/route-access";

/**
 * Proxy (equivalente ao antigo Middleware, renomeado no Next.js 16).
 *
 * Verificação OTIMISTA de rota, sem banco: sem cookie de sessão do Better
 * Auth, rotas protegidas redirecionam para /login. A presença do cookie NÃO
 * prova nada (pode estar revogado, expirado ou adulterado): a sessão é
 * conferida no banco pelo DAL (`lib/auth/dal.ts`) em cada página, e os dados
 * pela RLS — como recomenda a documentação do Next.js.
 *
 * Usuário com cookie nas telas de login/recuperação: decidido pela própria
 * página, que valida a sessão (com um cookie inválido, redirecionar daqui
 * criaria um ciclo /login ↔ /visao-geral).
 */
export function proxy(request: NextRequest) {
  if (
    isPublicPath(request.nextUrl.pathname) ||
    hasSessionCookie((name) => request.cookies.get(name)?.value)
  ) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
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
