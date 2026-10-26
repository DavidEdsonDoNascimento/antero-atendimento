import "server-only";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { getIdentityAuth, type IdentityAuth } from "./auth.ts";

/**
 * Handler HTTP da identidade — o que a Entrega 5B monta em
 * `app/api/auth/[...all]/route.ts` (`GET`/`POST`). Ainda não é usado por
 * nenhuma rota.
 *
 * O Better Auth relança erros inesperados (ex.: banco indisponível); aqui
 * eles viram 503 com mensagem neutra, sem `Set-Cookie`, e o log leva só o
 * código do erro — nunca e-mail, token, senha ou URL.
 */
export async function handleIdentityRequest(
  request: Request,
  auth: IdentityAuth = getIdentityAuth(),
): Promise<Response> {
  try {
    return await auth.handler(request);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    console.error(`[auth] requisição de autenticação falhou: ${typeof code === "string" ? code : "erro interno"}`);
    return Response.json({ message: "Serviço de autenticação indisponível. Tente novamente." }, { status: 503 });
  }
}
