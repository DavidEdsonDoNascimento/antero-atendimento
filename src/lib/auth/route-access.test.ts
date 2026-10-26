import assert from "node:assert/strict";
import { test } from "node:test";

import { hasSessionCookie, isPublicPath } from "./route-access.ts";

test("isPublicPath: telas de autenticação e o handler /api/auth são públicos", () => {
  for (const path of ["/login", "/recuperar-senha", "/redefinir-senha", "/api/auth", "/api/auth/sign-in/email"]) {
    assert.equal(isPublicPath(path), true, path);
  }
});

test("isPublicPath: plataforma, /sem-organizacao, raiz e prefixos parecidos são protegidos", () => {
  for (const path of ["/", "/visao-geral", "/conversas", "/admin", "/sem-organizacao", "/loginx", "/api/authx", "/api", "/auth/confirm"]) {
    assert.equal(isPublicPath(path), false, path);
  }
});

test("hasSessionCookie: exige o cookie do Better Auth com formato de token assinado", () => {
  const jar = (cookies: Record<string, string>) => (name: string) => cookies[name];
  assert.equal(hasSessionCookie(jar({})), false);
  assert.equal(hasSessionCookie(jar({ "antero.session_token": "" })), false);
  assert.equal(hasSessionCookie(jar({ "antero.session_token": "semponto" })), false);
  assert.equal(hasSessionCookie(jar({ "antero.session_token": "x".repeat(600) + ".y" })), false);
  assert.equal(hasSessionCookie(jar({ "sb-access-token": "a.b" })), false);
  assert.equal(hasSessionCookie(jar({ "antero.session_token": "token.assinatura" })), true);
  assert.equal(hasSessionCookie(jar({ "__Secure-antero.session_token": "token.assinatura" })), true);
});
