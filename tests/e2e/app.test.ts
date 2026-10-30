/**
 * Entrega 5B — ponta a ponta contra a aplicação Next.js REAL (proxy.ts, rota
 * /api/auth, DAL, páginas e consultas SQL), servida por `pnpm app:e2e` numa
 * cópia isolada (sem `.env*`) sobre o banco de TESTES e o Mailpit local.
 *
 * Os pedidos fazem o que o navegador faz: os formulários chamam o handler
 * `/api/auth/*` (com `Origin`) e as páginas são pedidas com o cookie
 * recebido. Cada "navegador" tem um IP próprio em `X-Forwarded-For` (como
 * clientes distintos atrás do proxy reverso) para os limites por IP não
 * interferirem entre os testes; o teste de rate limit usa um IP fixo.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { createLocalProvisioner } from "../../src/lib/identity/provision.ts";
import { connectFixtureClient } from "../db/harness.ts";
import { createTestIdentity, deleteMail, mailCount, uniqueIp, waitForMail, type TestIdentity } from "../db/identity-harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "../db/inbox-fixtures.ts";

const BASE = process.env.E2E_BASE_URL as string;
// Origem PÚBLICA da aplicação (a de BETTER_AUTH_URL). Igual a BASE no `pnpm
// app:e2e`; no contêiner de produção (`pnpm homolog:e2e`) é https e o
// servidor é alcançado direto por http, então as duas diferem.
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const SECURE = ORIGIN.startsWith("https:");
const SESSION_COOKIE = SECURE ? "__Secure-antero.session_token" : "antero.session_token";

let identity: TestIdentity;
let fixture: pg.Client;
let f: InboxFixtures | undefined;
const passwords = new Map<string, string>();

type Who = "aOwner" | "aAttendant" | "aDisabled" | "bOwner" | "nobody" | "multi" | "platformAdmin";
const LOCAL: Record<Who, string> = {
  aOwner: "a-owner",
  aAttendant: "a-attendant",
  aDisabled: "a-disabled",
  bOwner: "b-owner",
  nobody: "nobody",
  multi: "multi",
  platformAdmin: "platformadmin",
};
const emailOf = (who: Who) => `${LOCAL[who]}.${f!.suffix}@teste.local`;

/** Navegador mínimo: cookies, `Origin` nas chamadas ao handler, sem seguir redirecionamentos. */
class Client {
  readonly cookies = new Map<string, string>();
  readonly ip: string;

  constructor(ip = uniqueIp()) {
    this.ip = ip;
  }

  async fetch(path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const headers = new Headers({ "x-forwarded-for": this.ip });
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (init.origin !== null && method !== "GET") headers.set("origin", init.origin ?? ORIGIN);
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";").map((part) => part.trim());
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (value === "" || attributes.some((a) => /^max-age=0$/i.test(a))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  signIn(who: Who, password = passwords.get(who)!) {
    return this.fetch("/api/auth/sign-in/email", { body: { email: emailOf(who), password } });
  }

  /** Página: status, destino de redirecionamento (HTTP ou o `redirect()` em streaming) e HTML. */
  async page(path: string) {
    const response = await this.fetch(path);
    const html = response.status === 200 ? await response.text() : "";
    const streamed = /NEXT_REDIRECT;(?:replace|push);([^;]+);/.exec(html)?.[1];
    const location = response.headers.get("location");
    return {
      status: response.status,
      redirect: location ? new URL(location, BASE).pathname : (streamed ?? null),
      html,
    };
  }
}

async function loggedIn(who: Who): Promise<Client> {
  const client = new Client();
  const response = await client.signIn(who);
  assert.equal(response.status, 200, `login de ${who}`);
  return client;
}

before(async () => {
  assert.ok(BASE?.startsWith("http://127.0.0.1:"), "use `pnpm app:e2e`");
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
  // Credenciais pelo provisionamento local (fluxo oficial do Better Auth).
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  for (const who of Object.keys(LOCAL) as Who[]) {
    const result = await provisioner.provision({ email: emailOf(who), name: who, rotatePassword: true });
    passwords.set(who, result.password as string);
  }
});

after(async () => {
  if (f) {
    await deleteMail([emailOf("aAttendant")]);
    await dropInboxFixtures(fixture, f);
  }
  await fixture.end();
  await identity.close();
});

test("sem sessão: páginas protegidas → /login (proxy); telas públicas abertas", async () => {
  const anonymous = new Client();
  for (const path of ["/", "/visao-geral", "/conversas", `/conversas/${f!.conv.cH}`, "/equipe", "/admin", "/sem-organizacao"]) {
    const page = await anonymous.page(path);
    assert.equal(page.status, 307, path);
    assert.equal(page.redirect, "/login", path);
  }
  for (const path of ["/login", "/recuperar-senha", "/redefinir-senha"]) {
    assert.equal((await anonymous.page(path)).status, 200, path);
  }
  // O antigo /auth/confirm (redirecionamento aberto) não existe mais.
  const withCookie = new Client();
  withCookie.cookies.set(SESSION_COOKIE, "qualquer.coisa");
  assert.equal((await withCookie.page("/auth/confirm?next=//evil.example")).status, 404);
});

test("login pelo handler: cookie HttpOnly/SameSite=Lax; Inbox da organização ativa via SQL", async () => {
  const client = new Client();
  const response = await client.signIn("aOwner");
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((raw) => raw.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cookie);
  assert.match(cookie!, /HttpOnly/i);
  assert.match(cookie!, /SameSite=Lax/i);
  // Em https (produção) o cookie leva o prefixo __Secure- e o atributo Secure.
  assert.equal(/;\s*Secure/i.test(cookie!), SECURE);
  assert.match(cookie!, /Path=\//i);

  const inbox = await client.page("/conversas");
  assert.equal(inbox.status, 200);
  assert.match(inbox.html, /Histórico/);
  assert.match(inbox.html, /Org A Integração/);
  assert.doesNotMatch(inbox.html, /Contato B2|Org B Integração/);

  const detail = await client.page(`/conversas/${f!.conv.cH}`);
  assert.match(detail.html, /h7 atendente/);
  // Conversa de outra organização pela URL: "não encontrada", nada vaza.
  const foreign = await client.page(`/conversas/${f!.conv.cB2}`);
  assert.match(foreign.html, /Conversa não encontrada/);
  assert.doesNotMatch(foreign.html, /mensagem B2|Contato B2/);

  // Já autenticado em /login → plataforma (decidido pela página, após validar a sessão).
  assert.equal((await client.page("/login")).redirect, "/visao-geral");
});

test("senha errada e e-mail inexistente: mesmo 401; cadastro público 404; origem externa 403", async () => {
  const client = new Client();
  const wrong = await client.signIn("aOwner", "senha-errada-123");
  const unknown = await client.fetch("/api/auth/sign-in/email", {
    body: { email: `ninguem.${f!.suffix}@teste.local`, password: "senha-errada-123" },
  });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  assert.equal(client.cookies.size, 0);

  const signUp = await client.fetch("/api/auth/sign-up/email", {
    body: { email: `novo.${f!.suffix}@teste.local`, password: "senha-qualquer-123", name: "Novo" },
  });
  assert.equal(signUp.status, 404);

  const evil = await new Client().fetch("/api/auth/sign-in/email", {
    body: { email: emailOf("aOwner"), password: passwords.get("aOwner") },
    origin: "https://atacante.exemplo",
  });
  assert.equal(evil.status, 403);
});

test("rate limit no caminho da interface: 5 erros por minuto e a 6ª tentativa (mesmo certa) → 429", async () => {
  const client = new Client(uniqueIp());
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal((await client.signIn("aAttendant", `errada-${attempt}-123`)).status, 401, `tentativa ${attempt}`);
  }
  const blocked = await client.signIn("aAttendant");
  assert.equal(blocked.status, 429);
  assert.equal(client.cookies.size, 0);
  // Outro cliente (outro IP) não é afetado.
  assert.equal((await new Client().signIn("aAttendant")).status, 200);
});

test("papéis: atendente sem /admin; admin da plataforma sem organização → /sem-organizacao", async () => {
  const attendant = await loggedIn("aAttendant");
  const admin = await attendant.page("/admin");
  assert.equal(admin.redirect, "/visao-geral");
  assert.doesNotMatch(admin.html, /org-b-|Org B Integração/);
  assert.equal((await attendant.page("/equipe")).status, 200);

  const platformAdmin = await loggedIn("platformAdmin");
  assert.equal((await platformAdmin.page("/admin")).redirect, "/sem-organizacao");
});

test("organização ativa: vínculo mais antigo; desativado e sem vínculo → /sem-organizacao; URL não escolhe empresa", async () => {
  const multi = await loggedIn("multi");
  const inbox = await multi.page(`/conversas?organizationId=${f!.orgA}&org=${f!.orgA}`);
  assert.match(inbox.html, /Contato B2/);
  assert.doesNotMatch(inbox.html, /Histórico/);
  assert.match((await multi.page(`/conversas/${f!.conv.cH}`)).html, /Conversa não encontrada/);

  for (const who of ["aDisabled", "nobody"] as Who[]) {
    const client = await loggedIn(who);
    assert.equal((await client.page("/conversas")).redirect, "/sem-organizacao", who);
    const page = await client.page("/sem-organizacao");
    assert.equal(page.status, 200);
    assert.match(page.html, /Nenhuma organização vinculada/);
  }
});

test("cookie adulterado ou sessão revogada no banco → /login (o proxy sozinho não basta)", async () => {
  const client = await loggedIn("aOwner");
  const value = client.cookies.get(SESSION_COOKIE)!;

  const tampered = new Client();
  tampered.cookies.set(SESSION_COOKIE, `${value.slice(0, -3)}abc`);
  assert.equal((await tampered.page("/conversas")).redirect, "/login");

  // Sessão apagada no banco: o cookie continua idêntico, o acesso não.
  assert.equal((await client.page("/conversas")).status, 200);
  await fixture.query("DELETE FROM auth.sessions WHERE user_id = $1", [f!.users.aOwner]);
  const revoked = await client.page("/conversas");
  assert.equal(revoked.redirect, "/login");
  assert.doesNotMatch(revoked.html, /Histórico/);
  // /login com o cookie revogado mostra o formulário (sem ciclo de redirecionamento).
  assert.equal((await client.page("/login")).status, 200);
});

test("logout pelo handler: apaga a sessão e o cookie; o cookie antigo deixa de valer", async () => {
  const client = await loggedIn("bOwner");
  const oldCookie = client.cookies.get(SESSION_COOKIE)!;
  const signOut = await client.fetch("/api/auth/sign-out", { method: "POST", body: {} });
  assert.equal(signOut.status, 200);
  assert.equal(client.cookies.has(SESSION_COOKIE), false);

  const replay = new Client();
  replay.cookies.set(SESSION_COOKIE, oldCookie);
  assert.equal((await replay.page("/visao-geral")).redirect, "/login");
});

test("recuperação de senha pelo Mailpit: link, troca, sessões revogadas, token de uso único", async () => {
  const email = emailOf("aAttendant");
  const previous = await loggedIn("aAttendant");
  const seen = await mailCount(email);

  const request = await new Client().fetch("/api/auth/request-password-reset", {
    body: { email, redirectTo: "/redefinir-senha" },
  });
  assert.equal(request.status, 200);
  const mail = await waitForMail(email, seen);
  const link = mail.Text.match(/https?:\/\/\S+/)![0];
  assert.ok(link.startsWith(`${ORIGIN}/api/auth/reset-password/`));

  const browser = new Client();
  const callback = await browser.fetch(new URL(link).pathname + new URL(link).search);
  assert.equal(callback.status, 302);
  const target = new URL(callback.headers.get("location")!, BASE);
  assert.equal(target.pathname, "/redefinir-senha");
  const token = target.searchParams.get("token")!;
  const form = await browser.page(`${target.pathname}${target.search}`);
  assert.match(form.html, /Definir nova senha/);
  assert.match(form.html, /<meta name="referrer" content="no-referrer"/);

  const reset = await browser.fetch("/api/auth/reset-password", {
    body: { token, newPassword: "Nova-Senha-E2E-2026" },
  });
  assert.equal(reset.status, 200);
  passwords.set("aAttendant", "Nova-Senha-E2E-2026");

  // Sessão anterior revogada; senha antiga recusada; nova aceita.
  assert.equal((await previous.page("/conversas")).redirect, "/login");
  assert.equal((await loggedIn("aAttendant")).cookies.has(SESSION_COOKIE), true);

  // Token já usado: o link leva à tela de link inválido, e o POST é recusado.
  const reused = await browser.fetch(new URL(link).pathname + new URL(link).search);
  assert.match(reused.headers.get("location") ?? "", /error=INVALID_TOKEN/);
  const again = await browser.fetch("/api/auth/reset-password", { body: { token, newPassword: "Outra-Senha-E2E-99" } });
  assert.equal(again.status, 400);
  assert.match((await browser.page("/redefinir-senha?error=INVALID_TOKEN")).html, /Link inválido ou expirado/);

  // Destinos externos para o link de redefinição: recusados, sem e-mail.
  const count = await mailCount(email);
  for (const redirectTo of ["//atacante.exemplo", "https://atacante.exemplo/x", "javascript:alert(1)"]) {
    const refused = await new Client().fetch("/api/auth/request-password-reset", { body: { email, redirectTo } });
    assert.equal(refused.status, 403, redirectTo);
  }
  assert.equal(await mailCount(email), count);
});
