/**
 * Entrega 7A — a imagem de PRODUÇÃO atrás do Traefik com TLS (`pnpm
 * homolog:prod proxy`). Cobre o que o E2E direto não vê: https de verdade,
 * cookies `__Secure-`, health checks pelo proxy, as páginas da plataforma e a
 * falsificação de X-Forwarded-For (pelo proxy e com a aplicação exposta).
 *
 * Fixtures fictícias no banco DESCARTÁVEL de homologação. O proxy sobrescreve
 * X-Forwarded-For com o endereço de quem conecta, então TODA requisição pelo
 * proxy vem do mesmo IP (o gateway Docker): os limites por IP são compartilhados
 * entre os testes — por isso o teste de rate limit é o último a usar o proxy.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { createLocalProvisioner } from "../../src/lib/identity/provision.ts";
import { connectFixtureClient } from "../db/harness.ts";
import { createTestIdentity, uniqueIp, type TestIdentity } from "../db/identity-harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "../db/inbox-fixtures.ts";

const HTTPS = process.env.HOMOLOG_HTTPS_URL as string;
const DIRECT = process.env.HOMOLOG_DIRECT_URL as string;
const COOKIE = "__Secure-antero.session_token";

let identity: TestIdentity;
let fixture: pg.Client;
let f: InboxFixtures;
const passwords = new Map<string, string>();
const WHO = ["aOwner", "aAttendant", "bOwner", "platformAdmin"] as const;
type Who = (typeof WHO)[number];
const LOCAL: Record<Who, string> = { aOwner: "a-owner", aAttendant: "a-attendant", bOwner: "b-owner", platformAdmin: "platformadmin" };
const emailOf = (who: Who) => `${LOCAL[who]}.${f.suffix}@teste.local`;

class Client {
  readonly cookies = new Map<string, string>();
  readonly base: string;
  readonly forwardedFor?: string;

  constructor(base: string, forwardedFor?: string) {
    this.base = base;
    this.forwardedFor = forwardedFor;
  }

  async fetch(path: string, init: { body?: unknown; xff?: string | null } = {}) {
    const headers = new Headers();
    const xff = init.xff === undefined ? this.forwardedFor : (init.xff ?? undefined);
    if (xff) headers.set("x-forwarded-for", xff);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      headers.set("origin", HTTPS);
    }
    const response = await fetch(`${this.base}${path}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      const [name, value] = [pair.slice(0, eq), pair.slice(eq + 1)];
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return response;
  }

  signIn(who: Who, password = passwords.get(who)!, xff?: string) {
    return this.fetch("/api/auth/sign-in/email", { body: { email: emailOf(who), password }, xff });
  }

  async page(path: string) {
    const response = await this.fetch(path);
    const html = response.status === 200 ? await response.text() : "";
    const streamed = /NEXT_REDIRECT;(?:replace|push);([^;]+);/.exec(html)?.[1];
    const location = response.headers.get("location");
    return { status: response.status, redirect: location ? new URL(location, this.base).pathname : (streamed ?? null), html };
  }
}

async function loggedIn(who: Who): Promise<Client> {
  const client = new Client(HTTPS);
  const response = await client.signIn(who);
  assert.equal(response.status, 200, `login de ${who}`);
  return client;
}

before(async () => {
  assert.ok(HTTPS?.startsWith("https://") && DIRECT?.startsWith("http://"), "use `pnpm homolog:prod proxy`");
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
  // O administrador da plataforma precisa de organização para abrir /admin.
  await fixture.query(
    "INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')",
    [f.orgA, f.more.platformAdmin],
  );
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  for (const who of WHO) {
    const result = await provisioner.provision({ email: emailOf(who), name: who, rotatePassword: true });
    passwords.set(who, result.password as string);
  }
});

after(async () => {
  await dropInboxFixtures(fixture, f);
  await fixture.end();
  await identity.close();
});

test("health checks pelo proxy: públicos, sem detalhes, sem cache e sem anunciar o framework", async () => {
  const anonymous = new Client(HTTPS);
  for (const [path, body] of [["/api/health", { status: "ok" }], ["/api/health/ready", { status: "ok" }]] as const) {
    const response = await anonymous.fetch(path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), body, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-powered-by"), null);
  }
  const page = await anonymous.fetch("/login");
  assert.equal(page.headers.get("x-powered-by"), null);
  // Redirecionamentos do proxy.ts saem relativos (nada de 0.0.0.0:3000 vazando).
  const home = await anonymous.fetch("/visao-geral");
  assert.equal(home.status, 307);
  assert.equal(home.headers.get("location"), "/login");
});

test("login por https: cookie __Secure-, Secure, HttpOnly, SameSite=Lax, sem Domain", async () => {
  const client = new Client(HTTPS);
  const response = await client.signIn("aOwner");
  assert.equal(response.status, 200);
  const raw = response.headers.getSetCookie();
  const cookie = raw.find((value) => value.startsWith(`${COOKIE}=`));
  assert.ok(cookie, `cookies: ${raw.map((c) => c.split("=")[0]).join(",")}`);
  assert.match(cookie, /;\s*Secure/i);
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.match(cookie, /;\s*SameSite=Lax/i);
  assert.match(cookie, /;\s*Path=\//i);
  assert.doesNotMatch(cookie, /;\s*Domain=/i);
  assert.ok(!raw.some((value) => value.startsWith("antero.session_token=")), "sem cookie sem prefixo");
});

test("plataforma pelo contêiner de produção: visão geral, Inbox, filtro, histórico, equipe, configurações, admin", async () => {
  const owner = await loggedIn("aOwner");
  for (const [path, title] of [["/visao-geral", "Visão geral"], ["/equipe", "Equipe"], ["/configuracoes", "Configurações"]] as const) {
    const page = await owner.page(path);
    assert.equal(page.status, 200, path);
    assert.match(page.html, new RegExp(title), path);
  }
  const inbox = await owner.page("/conversas");
  assert.equal(inbox.status, 200);
  assert.match(inbox.html, /Org A Integração/);
  assert.doesNotMatch(inbox.html, /Contato B2|Org B Integração/);

  const filtered = await owner.page("/conversas?status=resolved");
  assert.equal(filtered.status, 200);
  assert.notEqual(filtered.html, inbox.html, "o filtro muda a lista");

  const history = await owner.page(`/conversas/${f.conv.cH}`);
  assert.equal(history.status, 200);
  assert.match(history.html, /h7 atendente/);
  // Isolamento entre organizações: conversa de B pela URL de A.
  const foreign = await owner.page(`/conversas/${f.conv.cB2}`);
  assert.match(foreign.html, /Conversa não encontrada/);
  assert.doesNotMatch(foreign.html, /mensagem B2|Contato B2/);

  // Papéis: dono sem /admin; administrador da plataforma com /admin.
  assert.equal((await owner.page("/admin")).redirect, "/visao-geral");
  const admin = await (await loggedIn("platformAdmin")).page("/admin");
  assert.equal(admin.status, 200);
  assert.match(admin.html, /Admin da plataforma/);

  // Organização B enxerga só a própria.
  const b = await (await loggedIn("bOwner")).page("/conversas");
  assert.match(b.html, /Contato B2/);
  assert.doesNotMatch(b.html, /Org A Integração/);
});

test("logout pelo proxy invalida a sessão; cadastro público segue desligado", async () => {
  const client = await loggedIn("aAttendant");
  assert.equal((await client.page("/conversas")).status, 200);
  const old = client.cookies.get(COOKIE)!;
  assert.equal((await client.fetch("/api/auth/sign-out", { body: {} })).status, 200);
  const replay = new Client(HTTPS);
  replay.cookies.set(COOKIE, old);
  assert.equal((await replay.page("/conversas")).redirect, "/login");
  const signUp = await new Client(HTTPS).fetch("/api/auth/sign-up/email", {
    body: { email: `novo.${f.suffix}@teste.local`, password: "senha-qualquer-123", name: "Novo" },
  });
  assert.equal(signUp.status, 404);
});

test("X-Forwarded-For forjado PELO PROXY não escapa do rate limit (o Traefik sobrescreve o cabeçalho)", { timeout: 120_000 }, async () => {
  // Os logins dos testes anteriores já usaram o balde do IP real: espera a
  // janela de 60 s (contada desde a última tentativa) para medir do zero.
  await new Promise((done) => setTimeout(done, 61_000));
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    // Cada tentativa finge ser um cliente diferente.
    const client = new Client(HTTPS);
    const response = await client.signIn("aOwner", "senha-errada-123", `${uniqueIp()}, ${uniqueIp()}`);
    statuses.push(response.status);
    if (response.status === 429) break;
  }
  // Exatamente 5 erros de senha por IP REAL (limite de /sign-in/email), apesar
  // de 9 "clientes" diferentes no cabeçalho; a 6ª tentativa já é 429.
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  // Já bloqueado pelo IP real: nem a senha CERTA passa e um novo XFF não ajuda.
  const blocked = await new Client(HTTPS).signIn("aOwner", passwords.get("aOwner")!, uniqueIp());
  assert.equal(blocked.status, 429);
});

test("RISCO CONHECIDO — aplicação exposta DIRETO: X-Forwarded-For forjado burla o rate limit por IP", async () => {
  // Caracterização, não aprovação: é exatamente o que ocorre se a porta da
  // aplicação for publicada. Ver docs/DEPLOY.md ("Proxy e X-Forwarded-For").
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const client = new Client(DIRECT);
    statuses.push((await client.signIn("aOwner", "senha-errada-123", uniqueIp())).status);
  }
  assert.ok(statuses.every((s) => s === 401), `sem proxy, nenhum 429 (burla do limite): ${statuses.join(",")}`);

  // Sem IP confiável utilizável (cabeçalho lixo) cai no balde compartilhado.
  const garbage: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    garbage.push((await new Client(DIRECT).signIn("aOwner", "senha-errada-123", "nao-e-um-ip")).status);
  }
  assert.ok(garbage.includes(429), `balde compartilhado "no-trusted-ip": ${garbage.join(",")}`);
});
