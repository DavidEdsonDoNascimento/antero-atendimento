/**
 * Entrega 5A — recuperação e redefinição de senha com o Better Auth REAL e o
 * Mailpit local: resposta neutra, link, token de uso único e com validade,
 * troca efetiva da senha, revogação das sessões e redirecionamentos seguros.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { getValidatedSession } from "../../src/lib/identity/session.ts";
import { connectFixtureClient } from "./harness.ts";
import {
  Browser,
  createTestIdentity,
  deleteMail,
  dropUsers,
  mailCount,
  provisionUsers,
  waitForMail,
  type ProvisionedUser,
  type TestIdentity,
} from "./identity-harness.ts";

let identity: TestIdentity;
let fixture: pg.Client;
let users: Record<"rosa" | "caio" | "lia" | "teo", ProvisionedUser>;
const strangers: string[] = [];

before(async () => {
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  ({ users } = await provisionUsers(identity, {
    rosa: "Rosa Teste",
    caio: "Caio Teste",
    lia: "Lia Teste",
    teo: "Teo Teste",
  }));
});

after(async () => {
  await deleteMail([...Object.values(users ?? {}).map((user) => user.email), ...strangers]);
  await dropUsers(Object.values(users ?? {}).map((user) => user.userId));
  await fixture.end();
  await identity.close();
});

const NEUTRAL = {
  status: true,
  message: "If this email exists in our system, check your email for the reset link",
};

/** Pede a redefinição e devolve o token extraído do link recebido no Mailpit. */
async function requestReset(user: ProvisionedUser, browser = new Browser(identity)) {
  const before = await mailCount(user.email);
  const response = await browser.request("/request-password-reset", {
    body: { email: user.email, redirectTo: "/redefinir-senha" },
  });
  assert.equal(response.status, 200);
  const mail = await waitForMail(user.email, before);
  const link = mail.Text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link, "link no e-mail");
  const url = new URL(link);
  const token = url.pathname.split("/").at(-1)!;
  return { mail, url, token };
}

test("pedido de recuperação: resposta neutra, idêntica para e-mail existente e inexistente", async () => {
  const stranger = `ninguem.${Date.now()}@teste.local`;
  strangers.push(stranger);
  const browser = new Browser(identity);
  const known = await browser.request("/request-password-reset", {
    body: { email: users.rosa.email, redirectTo: "/redefinir-senha" },
  });
  const unknown = await browser.request("/request-password-reset", {
    body: { email: stranger, redirectTo: "/redefinir-senha" },
  });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await known.json(), NEUTRAL);
  assert.deepEqual(await unknown.json(), NEUTRAL);
  await waitForMail(users.rosa.email);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await mailCount(stranger), 0, "nenhum e-mail para quem não existe");
});

test("e-mail capturado pelo Mailpit com link de redefinição para a própria origem", async () => {
  const { mail, url, token } = await requestReset(users.caio);
  assert.equal(mail.Subject, "Redefinição de senha — Antero Atendimento");
  assert.deepEqual(
    mail.To.map((recipient) => recipient.Address),
    [users.caio.email],
  );
  assert.equal(url.origin, identity.config.baseURL);
  assert.equal(url.pathname, `/api/auth/reset-password/${token}`);
  assert.equal(url.searchParams.get("callbackURL"), "/redefinir-senha");
  assert.match(token, /^[A-Za-z0-9_-]{24}$/);
  assert.match(mail.HTML, /Escolher uma nova senha/);
  // O token é guardado com prefixo e expira em 1 hora.
  const row = await fixture.query(
    "SELECT value, expires_at FROM auth.verifications WHERE identifier = $1",
    [`reset-password:${token}`],
  );
  assert.equal(row.rows[0].value, users.caio.userId);
  const ttl = (row.rows[0].expires_at.getTime() - Date.now()) / 1000;
  assert.ok(ttl > 3500 && ttl <= 3600, `validade ${ttl}s`);
});

test("link válido redireciona para /redefinir-senha?token=…; nova senha funciona, a antiga não", async () => {
  const user = users.lia;
  const loggedIn = new Browser(identity);
  assert.equal((await loggedIn.signIn(user.email, user.password)).status, 200);

  const { url, token } = await requestReset(user);
  const browser = new Browser(identity);
  const callback = await browser.request(`${url.pathname.replace("/api/auth", "")}${url.search}`);
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get("location")!);
  assert.equal(location.origin, identity.config.baseURL);
  assert.equal(location.pathname, "/redefinir-senha");
  assert.equal(location.searchParams.get("token"), token);

  const newPassword = "nova-senha-segura-123";
  const reset = await browser.request("/reset-password", { body: { token, newPassword } });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { status: true });

  assert.equal((await new Browser(identity).signIn(user.email, user.password)).status, 401, "senha antiga");
  assert.equal((await new Browser(identity).signIn(user.email, newPassword)).status, 200, "senha nova");
  assert.equal(await getValidatedSession(loggedIn.headers(), identity.auth), null, "sessões antigas revogadas");
  user.password = newPassword;
});

test("token reutilizado é recusado", async () => {
  const { token } = await requestReset(users.teo);
  const browser = new Browser(identity);
  const first = await browser.request("/reset-password", { body: { token, newPassword: "primeira-troca-123" } });
  assert.equal(first.status, 200);
  const second = await browser.request("/reset-password", { body: { token, newPassword: "segunda-troca-123" } });
  assert.equal(second.status, 400);
  assert.equal(((await second.json()) as { code: string }).code, "INVALID_TOKEN");
  assert.equal((await new Browser(identity).signIn(users.teo.email, "primeira-troca-123")).status, 200);
  users.teo.password = "primeira-troca-123";
});

test("token expirado é recusado (no link e na troca) e a senha não muda", async () => {
  const { url, token } = await requestReset(users.rosa);
  await fixture.query("UPDATE auth.verifications SET expires_at = now() - interval '1 second' WHERE identifier = $1", [
    `reset-password:${token}`,
  ]);
  const browser = new Browser(identity);
  const callback = await browser.request(`${url.pathname.replace("/api/auth", "")}${url.search}`);
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get("location")!);
  assert.equal(location.pathname, "/redefinir-senha");
  assert.equal(location.searchParams.get("error"), "INVALID_TOKEN");
  assert.equal(location.searchParams.get("token"), null);

  const reset = await browser.request("/reset-password", { body: { token, newPassword: "nao-deve-valer-123" } });
  assert.equal(reset.status, 400);
  assert.equal((await new Browser(identity).signIn(users.rosa.email, users.rosa.password)).status, 200);
});

test("token inventado e senha curta são recusados", async () => {
  const browser = new Browser(identity);
  const invented = await browser.request("/reset-password", {
    body: { token: "A".repeat(24), newPassword: "qualquer-senha-123" },
  });
  assert.equal(invented.status, 400);
  const { token } = await requestReset(users.caio);
  const short = await browser.request("/reset-password", { body: { token, newPassword: "curta" } });
  assert.equal(short.status, 400);
  assert.equal(((await short.json()) as { code: string }).code, "PASSWORD_TOO_SHORT");
});

test("destinos externos são recusados no pedido e no link (sem e-mail enviado)", async () => {
  const hostile = [
    "//atacante.exemplo/redefinir",
    "https://atacante.exemplo/redefinir",
    "http://localhost:3000.atacante.exemplo/x",
    "javascript:alert(1)",
    "/\\atacante.exemplo",
    "/%2F%2Fatacante.exemplo",
    "data:text/html,oi",
  ];
  const before = await mailCount(users.caio.email);
  for (const redirectTo of hostile) {
    const response = await new Browser(identity).request("/request-password-reset", {
      body: { email: users.caio.email, redirectTo },
    });
    assert.equal(response.status, 403, redirectTo);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await mailCount(users.caio.email), before, "nenhum e-mail com destino externo");

  const { token } = await requestReset(users.caio);
  for (const callbackURL of hostile) {
    const response = await new Browser(identity).request(
      `/reset-password/${token}?callbackURL=${encodeURIComponent(callbackURL)}`,
    );
    assert.equal(response.status, 403, callbackURL);
    assert.equal(response.headers.get("location"), null);
  }
});

test("logs não contêm token, senha, e-mail nem o link", async () => {
  identity.logs.length = 0;
  const { token } = await requestReset(users.caio);
  const browser = new Browser(identity);
  await browser.request("/reset-password", { body: { token, newPassword: "troca-com-log-123" } });
  await browser.request("/reset-password", { body: { token, newPassword: "troca-com-log-456" } });
  await new Browser(identity).request("/request-password-reset", {
    body: { email: users.caio.email, redirectTo: "https://atacante.exemplo" },
  });
  await new Browser(identity).signIn(users.caio.email, "senha-errada-qualquer");
  users.caio.password = "troca-com-log-123";

  const text = identity.logs.join("\n");
  assert.ok(identity.logs.length > 0, "houve registros para inspecionar");
  for (const secret of [token, "troca-com-log", users.caio.email, "atacante.exemplo", "reset-password/"]) {
    assert.ok(!text.includes(secret), `log contém ${secret.slice(0, 12)}`);
  }
});
