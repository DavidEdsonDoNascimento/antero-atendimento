// Regras do `proxy.ts`, puras (sem I/O, sem `next/server`) para serem
// testáveis com `node --test`. Extensão .ts explícita na importação de VALOR
// (ver nota em modules/conversations/cursor.ts).
import { SESSION_COOKIE_NAMES } from "../identity/constants.ts";

/** Rotas acessíveis sem sessão. */
export const PUBLIC_PREFIXES = [
  "/login",
  "/recuperar-senha",
  "/redefinir-senha",
  // Handler do Better Auth: login, logout e redefinição precisam funcionar
  // sem sessão; ele mesmo aplica origem/CSRF e rate limit.
  "/api/auth",
  // Health checks do contêiner/proxy (liveness e readiness): sem login e sem
  // dados — respondem só "ok"/"unavailable" (ver src/lib/health.ts).
  "/api/health",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Há um cookie de sessão com o formato de token assinado (`token.assinatura`)?
 * Checagem OTIMISTA: não prova que a sessão existe, nem que é válida.
 */
export function hasSessionCookie(getCookie: (name: string) => string | undefined): boolean {
  return SESSION_COOKIE_NAMES.some((name) => {
    const value = getCookie(name);
    return Boolean(value && value.includes(".") && value.length <= 512);
  });
}
