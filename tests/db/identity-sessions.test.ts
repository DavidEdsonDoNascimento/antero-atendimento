/**
 * Entrega 5A — login, sessões, cookies e logout com o Better Auth REAL
 * (handler HTTP + PostgreSQL descartável como antero_auth).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { IdentityUnavailableError } from "../../src/lib/identity/errors.ts";
import { getValidatedSession, signOutSession } from "../../src/lib/identity/session.ts";
import { connectFixtureClient } from "./harness.ts";
import {
  Browser,
  createTestIdentity,
  dropUsers,
  provisionUsers,
  testIdentityConfig,
  type ProvisionedUser,
  type TestIdentity,
} from "./identity-harness.ts";

let identity: TestIdentity;
let fixture: pg.Client;
let users: Record<"ana" | "bia", ProvisionedUser>;

const SESSION_COOKIE = "antero.session_token";

before(async () => {
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  ({ users } = await provisionUsers(identity, { ana: "Ana Teste", bia: "Bia Teste" }));
});

after(async () => {
  await dropUsers(Object.values(users ?? {}).map((user) => user.userId));
  await fixture.end();
  await identity.close();
});

const sessionRows = async (userId: string) =>
  (await fixture.query("SELECT id, token, expires_at FROM auth.sessions WHERE user_id = $1", [userId])).rows;

test("login correto: 200, sessão persistida no banco e cookie HttpOnly/SameSite=Lax", async () => {
  const browser = new Browser(identity);
  const response = await browser.signIn(users.ana.email, users.ana.password);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user: { id: string; email: string } };
  assert.equal(body.user.id, users.ana.userId);

  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(setCookie, "cookie de sessão emitido");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /;\s*Secure/i, "http://localhost: sem Secure");

  const rows = await sessionRows(users.ana.userId);
  assert.equal(rows.length, 1);
  // O cookie é `<token>.<assinatura HMAC>`; o token é o da linha no banco.
  assert.equal(decodeURIComponent(browser.cookies.get(SESSION_COOKIE)!).split(".")[0], rows[0].token);
});

test("sessão recuperada pelo cookie: o id é o UUID de public.profiles", async () => {
  const browser = new Browser(identity);
  await browser.signIn(users.ana.email, users.ana.password);
  const response = await browser.request("/get-session");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user: { id: string } };
  assert.equal(body.user.id, users.ana.userId);

  const session = await getValidatedSession(browser.headers(), identity.auth);
  assert.ok(session);
  assert.equal(session.userId, users.ana.userId);
  assert.ok(session.expiresAt.getTime() > Date.now() + 6 * 24 * 3600 * 1000, "validade de 7 dias");
  const profile = await fixture.query("SELECT id, email FROM public.profiles WHERE id = $1", [session.userId]);
  assert.equal(profile.rows[0]?.email, users.ana.email);
});

test("senha incorreta e usuário inexistente: mesma resposta (sem enumeração), nenhum cookie", async () => {
  const browser = new Browser(identity);
  const wrong = await browser.signIn(users.ana.email, "senha-errada-123");
  const unknown = await browser.signIn(`ninguem.${Date.now()}@teste.local`, "senha-errada-123");
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  assert.equal(browser.cookies.size, 0);
  assert.equal(wrong.headers.getSetCookie().length + unknown.headers.getSetCookie().length, 0);
});

test("e-mail em outra caixa funciona (normalização); e-mail malformado é recusado", async () => {
  const browser = new Browser(identity);
  assert.equal((await browser.signIn(users.ana.email.toUpperCase(), users.ana.password)).status, 200);
  assert.equal((await new Browser(identity).signIn("nao-e-email", "qualquer-coisa")).status, 400);
});

test("sem cookie, cookie adulterado ou de assinatura trocada → sem sessão", async () => {
  assert.equal(await getValidatedSession(new Headers(), identity.auth), null);

  const browser = new Browser(identity);
  await browser.signIn(users.ana.email, users.ana.password);
  const original = decodeURIComponent(browser.cookies.get(SESSION_COOKIE)!);
  const [token, signature] = original.split(".");
  const flip = (text: string) => (text[0] === "A" ? "B" : "A") + text.slice(1);

  for (const tampered of [`${flip(token)}.${signature}`, `${token}.${flip(signature)}`, token, "lixo"]) {
    const headers = new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(tampered)}` });
    assert.equal(await getValidatedSession(headers, identity.auth), null, tampered.slice(0, 8));
  }
  // O cookie íntegro continua válido.
  assert.ok(await getValidatedSession(browser.headers(), identity.auth));
});

test("cookie assinado com OUTRO segredo não é aceito", async () => {
  const other = createTestIdentity(
    testIdentityConfig({ BETTER_AUTH_SECRET: "outro-segredo-de-teste-0123456789-abcdefghijk" }),
  );
  try {
    const browser = new Browser(other);
    assert.equal((await browser.signIn(users.ana.email, users.ana.password)).status, 200);
    assert.ok(await getValidatedSession(browser.headers(), other.auth));
    assert.equal(await getValidatedSession(browser.headers(), identity.auth), null);
  } finally {
    await other.close();
  }
});

test("sessão expirada → sem sessão", async () => {
  const browser = new Browser(identity);
  await browser.signIn(users.bia.email, users.bia.password);
  const token = decodeURIComponent(browser.cookies.get(SESSION_COOKIE)!).split(".")[0];
  await fixture.query("UPDATE auth.sessions SET expires_at = now() - interval '1 second' WHERE token = $1", [token]);
  assert.equal(await getValidatedSession(browser.headers(), identity.auth), null);
  const response = await browser.request("/get-session");
  assert.equal(await response.json(), null);
});

test("logout: apaga a sessão no banco, limpa o cookie e o cookie antigo deixa de valer", async () => {
  const browser = new Browser(identity);
  await browser.signIn(users.bia.email, users.bia.password);
  const oldHeaders = browser.headers();
  const token = decodeURIComponent(browser.cookies.get(SESSION_COOKIE)!).split(".")[0];

  const response = await browser.request("/sign-out", { method: "POST", body: {} });
  assert.equal(response.status, 200);
  assert.ok(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/i.test(cookie)),
    "cookie limpo",
  );
  assert.equal(browser.cookies.has(SESSION_COOKIE), false);
  assert.equal((await fixture.query("SELECT 1 FROM auth.sessions WHERE token = $1", [token])).rowCount, 0);
  assert.equal(await getValidatedSession(oldHeaders, identity.auth), null, "cookie antigo reapresentado");
});

test("signOutSession (servidor) encerra a sessão e devolve o Set-Cookie de limpeza", async () => {
  const browser = new Browser(identity);
  await browser.signIn(users.bia.email, users.bia.password);
  const headers = await signOutSession(browser.headers(), identity.auth);
  assert.ok(headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=;`)));
  assert.equal(await getValidatedSession(browser.headers(), identity.auth), null);
});

test("sessões simultâneas são independentes; revogar uma não derruba a outra", async () => {
  const laptop = new Browser(identity);
  const phone = new Browser(identity);
  await laptop.signIn(users.ana.email, users.ana.password);
  await phone.signIn(users.ana.email, users.ana.password);
  const laptopSession = await getValidatedSession(laptop.headers(), identity.auth);
  const phoneSession = await getValidatedSession(phone.headers(), identity.auth);
  assert.ok(laptopSession && phoneSession);
  assert.notEqual(laptopSession.sessionId, phoneSession.sessionId);

  const list = await laptop.request("/list-sessions");
  const listed = (await list.json()) as { token: string }[];
  assert.ok(listed.length >= 2);

  const phoneToken = decodeURIComponent(phone.cookies.get(SESSION_COOKIE)!).split(".")[0];
  const revoke = await laptop.request("/revoke-session", { body: { token: phoneToken } });
  assert.equal(revoke.status, 200);
  assert.equal(await getValidatedSession(phone.headers(), identity.auth), null, "sessão revogada");
  assert.ok(await getValidatedSession(laptop.headers(), identity.auth), "a outra continua");

  await laptop.request("/revoke-sessions", { body: {} });
  assert.equal(await getValidatedSession(laptop.headers(), identity.auth), null, "revogar todas");
});

test("uma pessoa não revoga a sessão de outra", async () => {
  const ana = new Browser(identity);
  const bia = new Browser(identity);
  await ana.signIn(users.ana.email, users.ana.password);
  await bia.signIn(users.bia.email, users.bia.password);
  const biaToken = decodeURIComponent(bia.cookies.get(SESSION_COOKIE)!).split(".")[0];
  await ana.request("/revoke-session", { body: { token: biaToken } });
  assert.ok(await getValidatedSession(bia.headers(), identity.auth));
});

test("origem estranha com cookie de sessão (CSRF) é recusada", async () => {
  const browser = new Browser(identity);
  await browser.signIn(users.ana.email, users.ana.password);
  const response = await browser.request("/sign-out", { body: {}, origin: "https://atacante.exemplo" });
  assert.equal(response.status, 403);
  assert.ok(await getValidatedSession(browser.headers(), identity.auth), "sessão intacta");
});

test("origem https: cookie __Secure- com Secure", async () => {
  const secure = createTestIdentity(testIdentityConfig({ BETTER_AUTH_URL: "https://atendimento.exemplo" }));
  try {
    const browser = new Browser(secure);
    const response = await browser.signIn(users.ana.email, users.ana.password);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`__Secure-${SESSION_COOKIE}=`));
    assert.ok(cookie);
    assert.match(cookie, /;\s*Secure/i);
    assert.match(cookie, /HttpOnly/i);
  } finally {
    await secure.close();
  }
});

test("banco indisponível: login falha sem cookie e a sessão NÃO é considerada válida", async () => {
  const browser = new Browser(identity);
  await browser.signIn(users.ana.email, users.ana.password);
  const down = createTestIdentity(
    testIdentityConfig({
      AUTH_DATABASE_URL: identity.config.database.connectionString.replace(/:\d+\//, ":1/"),
      AUTH_DATABASE_CONNECT_TIMEOUT_MS: "500",
    }),
  );
  try {
    const login = await new Browser(down).signIn(users.ana.email, users.ana.password);
    assert.equal(login.status, 503);
    assert.deepEqual(await login.json(), { message: "Serviço de autenticação indisponível. Tente novamente." });
    assert.equal(login.headers.getSetCookie().length, 0);
    await assert.rejects(getValidatedSession(browser.headers(), down.auth), IdentityUnavailableError);
  } finally {
    await down.close();
  }
});
