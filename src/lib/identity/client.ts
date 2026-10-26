import { createAuthClient } from "better-auth/client";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { IDENTITY_BASE_PATH } from "./constants.ts";

/**
 * Cliente HTTP oficial do Better Auth, para o NAVEGADOR. Os formulários de
 * login, logout e senha chamam `/api/auth/*` por aqui — o mesmo handler que
 * aplica origem/CSRF e rate limit (o navegador envia `Origin` sozinho). Não
 * há Server Action de autenticação: chamar `auth.api.*` no servidor
 * contornaria o rate limit (ver docs/AUTH.md).
 *
 * Criado só no navegador, na primeira utilização, com a origem da própria
 * página (nada de URL vinda de variável pública).
 */
function createIdentityClient() {
  return createAuthClient({ baseURL: window.location.origin, basePath: IDENTITY_BASE_PATH });
}

let client: ReturnType<typeof createIdentityClient> | undefined;

export function identityClient() {
  if (typeof window === "undefined") {
    throw new Error("identityClient() só pode ser usado no navegador.");
  }
  client ??= createIdentityClient();
  return client;
}

/** Falha de uma chamada ao handler: status HTTP (0 = rede) e código do Better Auth. */
export type IdentityFailure = { status: number; code?: string };

/**
 * Executa uma chamada do cliente e normaliza o resultado: `null` em sucesso,
 * `IdentityFailure` em erro HTTP ou de rede (sem mensagem do servidor — o
 * texto mostrado ao usuário é sempre nosso).
 */
export async function callIdentity(
  call: () => Promise<{ error: { status: number; code?: string } | null }>,
): Promise<IdentityFailure | null> {
  try {
    const { error } = await call();
    return error ? { status: error.status, code: error.code } : null;
  } catch {
    return { status: 0 };
  }
}
