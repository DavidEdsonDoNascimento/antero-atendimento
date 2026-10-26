/**
 * Entrega 5A — limite de tentativas (rate limit do Better Auth 1.7.12, em
 * memória, por IP + rota) no login e na recuperação de senha.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { IDENTITY_RATE_LIMITS } from "../../src/lib/identity/options.ts";
import {
  Browser,
  createTestIdentity,
  deleteMail,
  dropUsers,
  provisionUsers,
  uniqueIp,
  type ProvisionedUser,
  type TestIdentity,
} from "./identity-harness.ts";

let identity: TestIdentity;
let users: Record<"alvo", ProvisionedUser>;

before(async () => {
  identity = createTestIdentity();
  ({ users } = await provisionUsers(identity, { alvo: "Alvo Teste" }));
});

after(async () => {
  await deleteMail(Object.values(users ?? {}).map((user) => user.email));
  await dropUsers(Object.values(users ?? {}).map((user) => user.userId));
  await identity.close();
});

test("login: 5 tentativas por minuto por IP; a 6ª recebe 429 mesmo com a senha certa", async () => {
  const { max, window } = IDENTITY_RATE_LIMITS["/sign-in/email"];
  const attacker = new Browser(identity);
  for (let attempt = 1; attempt <= max; attempt += 1) {
    const response = await attacker.signIn(users.alvo.email, `chute-${attempt}-errado`);
    assert.equal(response.status, 401, `tentativa ${attempt}`);
  }
  const blocked = await attacker.signIn(users.alvo.email, users.alvo.password);
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("x-retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= window, `X-Retry-After ${retryAfter}`);
  assert.equal(blocked.headers.getSetCookie().length, 0, "nenhuma sessão criada");
});

test("o bloqueio é por IP: outro IP continua entrando", async () => {
  const other = new Browser(identity);
  assert.equal((await other.signIn(users.alvo.email, users.alvo.password)).status, 200);
});

test("recuperação de senha: 3 pedidos por 5 minutos por IP; o 4º recebe 429", async () => {
  const { max } = IDENTITY_RATE_LIMITS["/request-password-reset"];
  const browser = new Browser(identity);
  for (let attempt = 1; attempt <= max; attempt += 1) {
    const response = await browser.request("/request-password-reset", {
      body: { email: `ninguem.${attempt}.${Date.now()}@teste.local`, redirectTo: "/redefinir-senha" },
    });
    assert.equal(response.status, 200);
  }
  const blocked = await browser.request("/request-password-reset", {
    body: { email: users.alvo.email, redirectTo: "/redefinir-senha" },
  });
  assert.equal(blocked.status, 429);
});

test("troca de senha por token: 5 tentativas por 5 minutos por IP", async () => {
  const { max } = IDENTITY_RATE_LIMITS["/reset-password"];
  const browser = new Browser(identity);
  for (let attempt = 1; attempt <= max; attempt += 1) {
    const response = await browser.request("/reset-password", {
      body: { token: `inventado${attempt}`.padEnd(24, "x"), newPassword: "qualquer-senha-123" },
    });
    assert.equal(response.status, 400);
  }
  const blocked = await browser.request("/reset-password", {
    body: { token: "inventado".padEnd(24, "y"), newPassword: "qualquer-senha-123" },
  });
  assert.equal(blocked.status, 429);
});

test("X-Forwarded-For com vários IPs sem proxy confiável não serve para fugir do limite", async () => {
  // Sem AUTH_TRUSTED_PROXIES, uma cadeia (spoofável) não é aceita como IP do
  // cliente: todas as variações caem no MESMO balde.
  const ip = uniqueIp();
  const statuses: number[] = [];
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const browser = new Browser(identity, `203.0.113.${attempt}, ${ip}`);
    statuses.push((await browser.signIn(users.alvo.email, `chute-${attempt}`)).status);
  }
  assert.ok(statuses.includes(429), `statuses: ${statuses.join(",")}`);
});

test("chamadas de servidor (auth.api) NÃO passam pelo rate limit — a Entrega 5B deve usar o handler", async () => {
  // Documenta o comportamento da biblioteca: o limite vale para requisições
  // HTTP (`auth.handler`), não para `auth.api.signInEmail` chamado direto.
  const results: string[] = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await identity.auth.api.signInEmail({
        body: { email: users.alvo.email, password: `chute-servidor-${attempt}` },
        headers: new Headers({ "x-forwarded-for": "198.51.100.7" }),
      });
      results.push("ok");
    } catch (error) {
      results.push(String((error as { statusCode?: number }).statusCode));
    }
  }
  assert.deepEqual(results, Array(8).fill("401"));
});
