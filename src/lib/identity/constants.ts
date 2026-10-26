/**
 * Constantes públicas da identidade, sem dependências nem segredo: usadas
 * pelo servidor (`options.ts`), pelo `proxy.ts` (só o nome do cookie) e pelo
 * cliente HTTP do navegador (`client.ts`). Nada aqui importa o Better Auth
 * do servidor, o `pg` ou variáveis de ambiente.
 */

/** Onde o handler HTTP do Better Auth está montado (`app/api/auth/[...all]/route.ts`). */
export const IDENTITY_BASE_PATH = "/api/auth";
/** Cookie de sessão: `antero.session_token` (`__Secure-antero.session_token` em https). */
export const IDENTITY_COOKIE_PREFIX = "antero";
/** Os dois nomes possíveis do cookie de sessão (http local e https). */
export const SESSION_COOKIE_NAMES = [
  `${IDENTITY_COOKIE_PREFIX}.session_token`,
  `__Secure-${IDENTITY_COOKIE_PREFIX}.session_token`,
] as const;
/** Página (relativa) que recebe `?token=` depois do link de redefinição. */
export const PASSWORD_RESET_PAGE = "/redefinir-senha";
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
