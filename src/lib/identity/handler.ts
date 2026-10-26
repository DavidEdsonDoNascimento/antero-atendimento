import "server-only";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { getIdentityAuth, type IdentityAuth } from "./auth.ts";

/**
 * Handler HTTP da identidade, montado em `app/api/auth/[...all]/route.ts`
 * (`GET`/`POST`). É o ÚNICO caminho de login, logout e redefinição de senha
 * da aplicação: os formulários postam para cá pelo cliente oficial do Better
 * Auth (`client.ts`), então toda tentativa passa pela checagem de origem/CSRF
 * e pelo rate limit do próprio handler — chamadas `auth.api.*` no servidor
 * não passariam (ver docs/AUTH.md).
 *
 * Banco indisponível ou erro interno aparecem de duas formas — o Better Auth
 * relança em alguns caminhos e, em outros (ex.: login), responde ele mesmo um
 * 5xx — e a configuração pode estar ausente/inválida. Todos viram o MESMO
 * 503 com mensagem neutra, sem `Set-Cookie`, e o log leva só o código do
 * erro — nunca e-mail, token, senha ou URL.
 */
export async function handleIdentityRequest(request: Request, auth?: IdentityAuth): Promise<Response> {
  let response: Response;
  try {
    response = await (auth ?? getIdentityAuth()).handler(request);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    const name = error instanceof Error ? error.name : "erro interno";
    console.error(`[auth] requisição de autenticação falhou: ${typeof code === "string" ? code : name}`);
    return unavailable();
  }
  if (response.status >= 500) {
    console.error(`[auth] requisição de autenticação falhou: HTTP ${response.status}`);
    return unavailable();
  }
  return response;
}

function unavailable(): Response {
  return Response.json({ message: "Serviço de autenticação indisponível. Tente novamente." }, { status: 503 });
}
