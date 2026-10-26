import { handleIdentityRequest } from "@/lib/identity/handler";

/**
 * Handler HTTP oficial do Better Auth (`src/lib/identity`): login
 * (`/sign-in/email`), logout (`/sign-out`), sessão (`/get-session`),
 * recuperação e redefinição de senha. Origem/CSRF, rate limit e as rotas
 * desligadas (cadastro público etc. → 404) são aplicados pelo próprio
 * Better Auth; banco indisponível → 503 neutro. Ver docs/AUTH.md.
 */
export async function GET(request: Request): Promise<Response> {
  return handleIdentityRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleIdentityRequest(request);
}
