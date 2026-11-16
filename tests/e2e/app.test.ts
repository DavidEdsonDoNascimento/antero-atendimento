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

test("papéis: atendente sem /admin; admin da plataforma não depende de organização ativa", async () => {
  const attendant = await loggedIn("aAttendant");
  const admin = await attendant.page("/admin");
  assert.equal(admin.redirect, "/visao-geral");
  assert.doesNotMatch(admin.html, /org-b-|Org B Integração/);
  assert.equal((await attendant.page("/equipe")).status, 200);

  const platformAdmin = await loggedIn("platformAdmin");
  const adminPage = await platformAdmin.page("/admin");
  assert.equal(adminPage.status, 200);
  assert.equal(adminPage.redirect, null);
  assert.match(adminPage.html, /Org A Integração/);
  assert.equal((await platformAdmin.page("/conversas")).redirect, "/sem-organizacao");
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

// ---------------------------------------------------------------------------
// E1A — suspensão de organizações
// ---------------------------------------------------------------------------

const setStatus = (organizationId: string, status: "active" | "inactive") =>
  fixture.query("UPDATE public.organizations SET status = $2 WHERE id = $1", [organizationId, status]);
const statusOf = async (organizationId: string) =>
  (await fixture.query("SELECT status FROM public.organizations WHERE id = $1", [organizationId])).rows[0].status as string;

/**
 * Chama a Server Action de situação como um POST direto, sem a interface, no
 * formato que o React usa com `useActionState` (id no cabeçalho, campos no corpo).
 * Desde a G2B a ação devolve uma mensagem (como a de módulos) em vez de levar à
 * página de erro.
 */
async function postStatusAction(client: Client, actionId: string, organizationId: string, status: string) {
  const form = new FormData();
  form.set("_1_organizationId", organizationId);
  form.set("_1_status", status);
  form.set("0", JSON.stringify(["$undefined", "$K1"]));
  const headers = new Headers({ "x-forwarded-for": client.ip, origin: ORIGIN, "next-action": actionId, accept: "text/x-component" });
  if (client.cookies.size) headers.set("cookie", [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  const response = await fetch(`${BASE}/admin`, { method: "POST", headers, body: form, redirect: "manual" });
  return {
    status: response.status,
    text: await response.text(),
    redirect: response.headers.get("x-action-redirect") ?? response.headers.get("location"),
  };
}

/** Id da ação do formulário de situação (o que tem `name="status"`). */
const statusActionIdOf = (html: string) => {
  const form = html.split("<form").find((segment) => segment.includes('name="status"')) ?? "";
  return (
    /\$ACTION_ID_([0-9a-f]{20,})/.exec(form)?.[1] ??
    /&quot;id&quot;:&quot;([0-9a-f]{20,})&quot;/.exec(form)?.[1] ??
    /"id":"([0-9a-f]{20,})"/.exec(form)?.[1]
  );
};
const STATUS_CHANGED = /Organização (suspensa|reativada)\./;

test("suspensão: sessão existente perde o acesso e vê a tela própria; URL direta não contorna; reativação restaura", async () => {
  // Login novo: a sessão do aOwner foi revogada em um teste anterior.
  const owner = await loggedIn("aOwner");
  const attendant = await loggedIn("aAttendant");
  assert.equal((await owner.page("/conversas")).status, 200);

  await setStatus(f!.orgA, "inactive");
  try {
    for (const client of [owner, attendant]) {
      for (const path of ["/visao-geral", "/conversas", `/conversas/${f!.conv.cH}`, "/contatos", "/fluxos", "/equipe", "/configuracoes"]) {
        const page = await client.page(path);
        assert.equal(page.redirect, "/organizacao-suspensa", path);
        assert.doesNotMatch(page.html, /h7 atendente|Histórico|Org B Integração/, path);
      }
    }
    // A sessão continua válida (identidade): /login leva à plataforma.
    assert.equal((await owner.page("/login")).redirect, "/visao-geral");

    const screen = await owner.page("/organizacao-suspensa");
    assert.equal(screen.status, 200);
    assert.match(screen.html, /Organização suspensa/);
    assert.match(screen.html, /Org A Integração/);
    assert.doesNotMatch(screen.html, /Nenhuma organização vinculada/);
    assert.equal((await owner.page("/sem-organizacao")).redirect, "/organizacao-suspensa");
    // Não é admin da plataforma: /admin → /visao-geral → /organizacao-suspensa.
    const denied = await owner.page("/admin");
    assert.equal(denied.redirect, "/visao-geral");
    assert.doesNotMatch(denied.html, /Org B Integração/);
  } finally {
    await setStatus(f!.orgA, "active");
  }

  assert.equal((await owner.page("/conversas")).status, 200);
  assert.match((await owner.page(`/conversas/${f!.conv.cH}`)).html, /h7 atendente/);
  // Sem suspensão, a tela não se aplica.
  assert.equal((await owner.page("/organizacao-suspensa")).redirect, "/visao-geral");
});

test("suspensão: sem vínculo continua em /sem-organizacao; outra empresa e vínculo múltiplo seguem operando", async () => {
  const nobody = await loggedIn("nobody");
  const bOwner = await loggedIn("bOwner");
  const multi = await loggedIn("multi");
  const cH = f!.conv.cH;

  await setStatus(f!.orgB, "inactive");
  try {
    assert.equal((await nobody.page("/conversas")).redirect, "/sem-organizacao");
    assert.equal((await nobody.page("/organizacao-suspensa")).redirect, "/visao-geral");
    assert.equal((await bOwner.page("/conversas")).redirect, "/organizacao-suspensa");
    // multi: B (vínculo mais antigo) suspensa → passa a operar em A, sem bloqueio.
    const inbox = await multi.page("/conversas");
    assert.equal(inbox.status, 200);
    assert.match(inbox.html, /Histórico/);
    assert.doesNotMatch(inbox.html, /Contato B2/);
    assert.match((await multi.page(`/conversas/${cH}`)).html, /h7 atendente/);
    assert.match((await multi.page(`/conversas/${f!.conv.cB2}`)).html, /Conversa não encontrada/);
  } finally {
    await setStatus(f!.orgB, "active");
  }
});

test("Server Action de status: só o admin da plataforma; POST direto de outros papéis não tem efeito", async () => {
  const platformAdmin = await loggedIn("platformAdmin");
  const owner = await loggedIn("aOwner");
  const attendant = await loggedIn("aAttendant");

  const adminPage = await platformAdmin.page("/admin");
  const actionId = statusActionIdOf(adminPage.html);
  assert.ok(actionId, "formulário da ação em /admin");

  // Sem sessão, atendente e owner, inclusive o owner tentando se reativar.
  const anonymous = await postStatusAction(new Client(), actionId, f!.orgB, "inactive");
  assert.equal(anonymous.status, 307, "sem sessão: o proxy leva ao login");
  for (const client of [attendant, owner]) {
    const denied = await postStatusAction(client, actionId, f!.orgB, "inactive");
    assert.match(denied.redirect ?? "", /\/visao-geral/, "sem o papel: o DAL redireciona");
    assert.doesNotMatch(denied.text, STATUS_CHANGED);
    assert.equal(await statusOf(f!.orgB), "active");
  }
  await setStatus(f!.orgA, "inactive");
  try {
    const denied = await postStatusAction(owner, actionId, f!.orgA, "active");
    assert.match(denied.redirect ?? "", /\/visao-geral/);
    assert.doesNotMatch(denied.text, STATUS_CHANGED);
    assert.equal(await statusOf(f!.orgA), "inactive");

    // O admin da plataforma vê a suspensa em /admin, mesmo sem organização ativa.
    assert.match((await platformAdmin.page("/admin")).html, /Suspensa/);
    // Entrada inválida e organização inexistente: mensagem, sem página de erro e sem efeito.
    const invalid = await postStatusAction(platformAdmin, actionId, "nao-e-uuid", "active");
    assert.match(invalid.text, /Dados inválidos/);
    assert.match((await postStatusAction(platformAdmin, actionId, f!.orgA, "talvez")).text, /Dados inválidos/);
    assert.match(
      (await postStatusAction(platformAdmin, actionId, "00000000-0000-4000-8000-000000000000", "active")).text,
      /Organização não encontrada/,
    );
    assert.equal(await statusOf(f!.orgA), "inactive");

    const allowed = await postStatusAction(platformAdmin, actionId, f!.orgA, "active");
    assert.match(allowed.text, /Organização reativada\./);
    assert.equal(await statusOf(f!.orgA), "active");
    assert.equal((await owner.page("/conversas")).status, 200);

    const suspend = await postStatusAction(platformAdmin, actionId, f!.orgA, "inactive");
    assert.match(suspend.text, /Organização suspensa\./);
    assert.equal(await statusOf(f!.orgA), "inactive");
    assert.equal((await owner.page("/conversas")).redirect, "/organizacao-suspensa");
  } finally {
    await setStatus(f!.orgA, "active");
  }
});

test("admin da plataforma com vínculo só em organização suspensa alcança /admin para reativá-la", async () => {
  await fixture.query(
    "INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [f!.orgC, f!.more.platformAdmin],
  );
  const platformAdmin = await loggedIn("platformAdmin");
  await setStatus(f!.orgC, "inactive");
  try {
    assert.equal((await platformAdmin.page("/visao-geral")).redirect, "/organizacao-suspensa");
    const screen = await platformAdmin.page("/organizacao-suspensa");
    assert.match(screen.html, /href="\/admin"/);
    const admin = await platformAdmin.page("/admin");
    assert.equal(admin.status, 200);
    assert.match(admin.html, /Org C Vazia/);
  } finally {
    await setStatus(f!.orgC, "active");
    await fixture.query("DELETE FROM public.organization_members WHERE user_id = $1", [f!.more.platformAdmin]);
  }
});

// ---------------------------------------------------------------------------
// E1B — módulos por organização
// ---------------------------------------------------------------------------

const MODULE_ROUTES = [
  ["atendimento", "/conversas", "Conversas"],
  ["contatos", "/contatos", "Contatos"],
  ["automacoes", "/fluxos", "Automações"],
  ["campanhas", "/campanhas", "Campanhas"],
] as const;

/** Ajusta a configuração como dono das tabelas, só para montar o cenário. */
async function setModules(organizationId: string, enabled: string[]) {
  await fixture.query("DELETE FROM public.organization_modules WHERE organization_id = $1", [organizationId]);
  for (const name of enabled) {
    await fixture.query("INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, $2, true)", [
      organizationId,
      name,
    ]);
  }
}

const enabledModules = async (organizationId: string) =>
  (
    await fixture.query(
      "SELECT module::text FROM public.organization_modules WHERE organization_id = $1 AND enabled ORDER BY module",
      [organizationId],
    )
  ).rows.map((row) => row.module as string);

/** O menu renderizado contém o link para esta rota? */
const menuHasLink = (html: string, href: string) => new RegExp(`<a[^>]+href="${href}"`).test(html);

/**
 * Chama a Server Action do painel como um POST direto, no formato que o React
 * usa para `useActionState` (id no cabeçalho, argumentos no corpo).
 */
async function postModuleAction(client: Client, actionId: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(`_1_${name}`, value);
  // Por último, como no React: o servidor resolve a linha 0 ao recebê-la.
  form.set("0", JSON.stringify(["$undefined", "$K1"]));
  const headers = new Headers({ "x-forwarded-for": client.ip, origin: ORIGIN, "next-action": actionId, accept: "text/x-component" });
  if (client.cookies.size) headers.set("cookie", [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  const response = await fetch(`${BASE}/admin/organizacoes/${fields.organizationId}`, {
    method: "POST",
    headers,
    body: form,
    redirect: "manual",
  });
  return { status: response.status, text: await response.text() };
}

// O detalhe da organização tem outros formulários (situação): procura só o do painel de módulos.
const moduleActionIdOf = (html: string) => {
  const form = html.split("<form").find((segment) => segment.includes('name="module"')) ?? html;
  return (
    /\$ACTION_ID_([0-9a-f]{20,})/.exec(form)?.[1] ??
    /&quot;id&quot;:&quot;([0-9a-f]{20,})&quot;/.exec(form)?.[1] ??
    /"id":"([0-9a-f]{20,})"/.exec(form)?.[1]
  );
};

test("módulos: menu e rotas seguem a organização ativa; URL direta é negada no servidor", async () => {
  const owner = await loggedIn("aOwner");
  const bOwner = await loggedIn("bOwner");
  await setModules(f!.orgA, ["automacoes"]);
  await setModules(f!.orgB, ["atendimento", "contatos", "campanhas"]);
  try {
    const home = await owner.page("/visao-geral");
    assert.equal(home.status, 200);
    assert.ok(menuHasLink(home.html, "/fluxos"), "A: Automações no menu");
    for (const href of ["/conversas", "/contatos", "/campanhas"]) assert.ok(!menuHasLink(home.html, href), `A: sem ${href} no menu`);
    for (const href of ["/visao-geral", "/equipe", "/configuracoes"]) assert.ok(menuHasLink(home.html, href), `A: núcleo ${href}`);

    for (const path of ["/conversas", `/conversas/${f!.conv.cH}`]) {
      const denied = await owner.page(path);
      assert.equal(denied.redirect, "/modulo-indisponivel?modulo=atendimento", path);
      assert.doesNotMatch(denied.html, /h7 atendente|Histórico/, path);
    }
    assert.equal((await owner.page("/contatos")).redirect, "/modulo-indisponivel?modulo=contatos");
    assert.equal((await owner.page("/campanhas")).redirect, "/modulo-indisponivel?modulo=campanhas");
    const enabled = await owner.page("/fluxos");
    assert.equal(enabled.status, 200);
    assert.equal(enabled.redirect, null);
    assert.match(enabled.html, /Nenhuma automação ainda/);

    // A tela de indisponível não confia no parâmetro.
    const screen = await owner.page("/modulo-indisponivel?modulo=atendimento");
    assert.match(screen.html, /Atendimento não está disponível/);
    assert.match(screen.html, /Org A Integração/);
    assert.match((await owner.page("/modulo-indisponivel?modulo=%3Cscript%3E")).html, /Recurso não disponível/);
    assert.equal((await owner.page("/modulo-indisponivel?modulo=automacoes")).redirect, "/fluxos");

    // Outra organização, outra configuração, mesma plataforma.
    const homeB = await bOwner.page("/visao-geral");
    for (const href of ["/conversas", "/contatos", "/campanhas"]) assert.ok(menuHasLink(homeB.html, href), `B: ${href} no menu`);
    assert.ok(!menuHasLink(homeB.html, "/fluxos"), "B: sem Automações no menu");
    assert.equal((await bOwner.page("/conversas")).status, 200);
    assert.match((await bOwner.page("/conversas")).html, /Contato B2/);
    assert.equal((await bOwner.page("/fluxos")).redirect, "/modulo-indisponivel?modulo=automacoes");
    const campaigns = await bOwner.page("/campanhas");
    assert.equal(campaigns.status, 200);
    assert.match(campaigns.html, /o envio não está disponível/);
  } finally {
    await setModules(f!.orgA, ["atendimento"]);
    await setModules(f!.orgB, ["atendimento"]);
  }
  // Dados preservados: a Inbox volta intacta.
  assert.match((await owner.page(`/conversas/${f!.conv.cH}`)).html, /h7 atendente/);
});

test("módulos: painel do admin altera na requisição seguinte; dependência respeitada; outra organização intacta", async () => {
  const platformAdmin = await loggedIn("platformAdmin");
  const owner = await loggedIn("aOwner");
  const list = await platformAdmin.page("/admin");
  assert.match(list.html, new RegExp(`/admin/organizacoes/${f!.orgA}`));
  assert.match(list.html, /Módulos habilitados/);

  const panel = await platformAdmin.page(`/admin/organizacoes/${f!.orgA}`);
  assert.equal(panel.status, 200, "admin da plataforma sem vínculo abre o painel");
  assert.match(panel.html, /Org A Integração/);
  for (const label of ["Atendimento", "Automações", "Campanhas", "Contatos"]) assert.match(panel.html, new RegExp(label));
  // O React separa trechos de texto com comentários no HTML.
  assert.match(panel.html.replaceAll("<!-- -->", ""), /Depende de Contatos/);
  assert.match(panel.html, /Habilite Contatos antes de habilitar Campanhas/);
  const actionId = moduleActionIdOf(panel.html);
  assert.ok(actionId, "id da ação no painel");
  assert.equal((await platformAdmin.page("/admin/organizacoes/nao-e-uuid")).status, 404);
  assert.equal((await platformAdmin.page("/admin/organizacoes/00000000-0000-4000-8000-000000000000")).status, 404);

  const post = (module: string, enabled: boolean, organizationId = f!.orgA) =>
    postModuleAction(platformAdmin, actionId, { organizationId, module, enabled: String(enabled) });
  try {
    // Sem Contatos, Campanhas é recusado com explicação.
    const refused = await post("campanhas", true);
    assert.match(refused.text, /Habilite Contatos antes de habilitar Campanhas/);
    assert.deepEqual(await enabledModules(f!.orgA), ["atendimento"]);

    assert.match((await post("contatos", true)).text, /Contatos habilitado/);
    assert.match((await post("campanhas", true)).text, /Campanhas habilitado/);
    assert.deepEqual(await enabledModules(f!.orgA), ["atendimento", "campanhas", "contatos"]);
    assert.match((await post("contatos", false)).text, /Desabilite Campanhas antes de desabilitar Contatos/);
    assert.deepEqual(await enabledModules(f!.orgA), ["atendimento", "campanhas", "contatos"]);

    // Requisição seguinte, mesma sessão do owner.
    const home = await owner.page("/visao-geral");
    assert.ok(menuHasLink(home.html, "/campanhas"));
    assert.equal((await owner.page("/campanhas")).status, 200);

    assert.match((await post("atendimento", false)).text, /Atendimento desabilitado/);
    assert.equal((await owner.page("/conversas")).redirect, "/modulo-indisponivel?modulo=atendimento");
    assert.ok(!menuHasLink((await owner.page("/visao-geral")).html, "/conversas"));
    assert.deepEqual(await enabledModules(f!.orgB), ["atendimento"], "B não muda");
    assert.equal((await (await loggedIn("bOwner")).page("/conversas")).status, 200);

    // Entrada adulterada: nada muda, com resposta segura.
    for (const fields of [
      { organizationId: "nao-e-uuid", module: "atendimento", enabled: "true" },
      { organizationId: f!.orgA, module: "financeiro", enabled: "true" },
      { organizationId: f!.orgA, module: "atendimento", enabled: "talvez" },
    ]) {
      assert.match((await postModuleAction(platformAdmin, actionId, fields)).text, /Dados inválidos/);
    }
    assert.match((await post("atendimento", true, "00000000-0000-4000-8000-000000000000")).text, /Organização não encontrada/);
    assert.deepEqual(await enabledModules(f!.orgA), ["campanhas", "contatos"]);
  } finally {
    await setModules(f!.orgA, ["atendimento"]);
  }
});

test("módulos: usuários comuns não acessam o painel nem a ação, mesmo por POST direto", async () => {
  const platformAdmin = await loggedIn("platformAdmin");
  const panel = await platformAdmin.page(`/admin/organizacoes/${f!.orgA}`);
  const actionId = moduleActionIdOf(panel.html)!;
  const fields = { organizationId: f!.orgA, module: "contatos", enabled: "true" };

  const owner = await loggedIn("aOwner");
  const attendant = await loggedIn("aAttendant");
  const outsider = await loggedIn("bOwner");
  for (const client of [owner, attendant, outsider]) {
    const page = await client.page(`/admin/organizacoes/${f!.orgA}`);
    assert.equal(page.redirect, "/visao-geral");
    assert.doesNotMatch(page.html, /Org A Integração[\s\S]*Depende de Contatos/);
  }
  const anonymous = await new Client().page(`/admin/organizacoes/${f!.orgA}`);
  assert.equal(anonymous.redirect, "/login");

  // Inclusive a própria organização e sem sessão.
  for (const client of [new Client(), owner, attendant, outsider]) {
    await postModuleAction(client, actionId, fields);
    assert.deepEqual(await enabledModules(f!.orgA), ["atendimento"]);
  }
});

test("módulos: usuário com duas organizações recebe a configuração do contexto ativo", async () => {
  const multi = await loggedIn("multi");
  await setModules(f!.orgB, ["contatos"]);
  await setModules(f!.orgA, ["atendimento"]);
  try {
    // B é o vínculo mais antigo: vale a configuração de B, não a de A.
    assert.equal((await multi.page("/conversas")).redirect, "/modulo-indisponivel?modulo=atendimento");
    assert.equal((await multi.page("/contatos")).status, 200);
    await setStatus(f!.orgB, "inactive");
    assert.match((await multi.page("/conversas")).html, /Histórico/);
    assert.equal((await multi.page("/contatos")).redirect, "/modulo-indisponivel?modulo=contatos");
  } finally {
    await setStatus(f!.orgB, "active");
    await setModules(f!.orgB, ["atendimento"]);
  }
});

test("módulos: suspensão prevalece sobre os módulos; reativação preserva a configuração", async () => {
  const owner = await loggedIn("aOwner");
  const platformAdmin = await loggedIn("platformAdmin");
  await setModules(f!.orgA, ["atendimento", "automacoes", "contatos"]);
  await setStatus(f!.orgA, "inactive");
  try {
    for (const [, path] of MODULE_ROUTES) assert.equal((await owner.page(path)).redirect, "/organizacao-suspensa", path);
    assert.equal((await owner.page("/modulo-indisponivel?modulo=contatos")).redirect, "/organizacao-suspensa");
    // O admin da plataforma ainda vê e ajusta a configuração da suspensa.
    const panel = await platformAdmin.page(`/admin/organizacoes/${f!.orgA}`);
    assert.equal(panel.status, 200);
    assert.match(panel.html, /nenhum módulo opera/);
  } finally {
    await setStatus(f!.orgA, "active");
  }
  assert.deepEqual(await enabledModules(f!.orgA), ["atendimento", "automacoes", "contatos"]);
  assert.equal((await owner.page("/fluxos")).status, 200);
  await setModules(f!.orgA, ["atendimento"]);
});

test("módulos: toda rota do catálogo é protegida (organização sem nenhum módulo)", async () => {
  const owner = await loggedIn("aOwner");
  await setModules(f!.orgA, []);
  try {
    for (const [name, path, label] of MODULE_ROUTES) {
      assert.equal((await owner.page(path)).redirect, `/modulo-indisponivel?modulo=${name}`, path);
      const home = await owner.page("/visao-geral");
      assert.ok(!menuHasLink(home.html, path), `${label} fora do menu`);
    }
    // O núcleo continua: visão geral, equipe e configurações.
    for (const path of ["/visao-geral", "/equipe", "/configuracoes"]) assert.equal((await owner.page(path)).status, 200, path);
  } finally {
    await setModules(f!.orgA, ["atendimento"]);
  }
});

// ---------------------------------------------------------------------------
// G1 — central de organizações
// ---------------------------------------------------------------------------

const textOf = (html: string) => html.replaceAll("<!-- -->", "");

test("central: lista com busca e filtro por situação, detalhes da organização e volta à lista", async () => {
  const platformAdmin = await loggedIn("platformAdmin");

  const list = await platformAdmin.page("/admin");
  assert.equal(list.status, 200);
  assert.match(list.html, /Administração da plataforma/, "o cabeçalho diz que é a administração, não uma organização");
  assert.match(list.html, /role="search"/);
  for (const name of ["Org A Integração", "Org B Integração", "Org C Vazia"]) assert.match(list.html, new RegExp(name));
  assert.match(list.html, new RegExp(`href="/admin/organizacoes/${f!.orgA}"`));

  // Busca: sem acento nem caixa, e só a organização encontrada permanece.
  const search = await platformAdmin.page("/admin?busca=ORG%20a%20integracao");
  assert.match(search.html, /Org A Integração/);
  assert.doesNotMatch(search.html, /Org B Integração|Org C Vazia/);
  const none = await platformAdmin.page("/admin?busca=nao-existe-xyz");
  assert.match(none.html, /Nenhuma organização encontrada/);
  assert.match(none.html, /Limpar filtros/);

  // Situação: C suspensa aparece só em "Suspensas".
  await setStatus(f!.orgC, "inactive");
  try {
    const suspended = await platformAdmin.page("/admin?situacao=inactive");
    assert.match(suspended.html, /Org C Vazia/);
    assert.doesNotMatch(suspended.html, /Org A Integração|Org B Integração/);
    const active = await platformAdmin.page("/admin?situacao=active");
    assert.doesNotMatch(active.html, /Org C Vazia/);
    assert.match(active.html, /Org A Integração/);
    const both = await platformAdmin.page("/admin?situacao=inactive&busca=org%20a");
    assert.match(both.html, /Nenhuma organização encontrada/);
  } finally {
    await setStatus(f!.orgC, "active");
  }

  // Valores estranhos na URL: sem erro, sem filtro indevido.
  for (const query of ["busca=%25", "busca=_", "busca=%27%20OR%201%3D1%20--", "situacao=todas", "situacao=active%27", `busca=${"x".repeat(500)}`]) {
    const odd = await platformAdmin.page(`/admin?${query}`);
    assert.equal(odd.status, 200, query);
    assert.equal(odd.redirect, null, query);
  }
  assert.match((await platformAdmin.page("/admin?busca=%25")).html, /Nenhuma organização encontrada/);

  // Detalhes: dados, módulos, equipe, canal, aviso de escopo e retorno.
  const detail = await platformAdmin.page(`/admin/organizacoes/${f!.orgA}`);
  assert.equal(detail.status, 200);
  const text = textOf(detail.html);
  assert.match(text, /Org A Integração/);
  assert.match(text, /Voltar às organizações/);
  assert.match(text, /href="\/admin"/);
  assert.match(text, /Dados da organização/);
  assert.match(text, /Módulos contratados/);
  assert.match(text, /Equipe \(4\)/);
  for (const who of ["aOwner", "aAttendant", "aDisabled"] as Who[]) assert.match(text, new RegExp(emailOf(who).replace(".", "\\.")));
  assert.match(text, /Proprietário/);
  assert.match(text, /Desativado/);
  assert.match(text, /Canal de atendimento/);
  assert.match(text, /como administrador da\s+plataforma|como administrador da plataforma/);
  assert.match(text, /será disponibilizada em\s+uma entrega futura|será disponibilizada em uma entrega futura/);
  // O que não pode aparecer: dados operacionais e identificadores técnicos do canal.
  assert.doesNotMatch(text, /h7 atendente|Mensagem longa|Contato B2/);
  assert.doesNotMatch(text, new RegExp(f!.conv.c1));
});

test("central: abrir uma organização não vira vínculo nem troca a organização dos módulos operacionais", async () => {
  const platformAdmin = await loggedIn("platformAdmin");
  const countMembers = async () =>
    Number((await fixture.query("SELECT count(*) AS n FROM public.organization_members WHERE user_id = $1", [f!.more.platformAdmin])).rows[0].n);
  assert.equal(await countMembers(), 0);

  for (const organizationId of [f!.orgA, f!.orgB, f!.orgC]) {
    assert.equal((await platformAdmin.page(`/admin/organizacoes/${organizationId}`)).status, 200);
  }
  assert.equal(await countMembers(), 0, "nenhum vínculo criado");
  assert.equal([...platformAdmin.cookies.keys()].filter((name) => !name.includes("session")).length, 0, "nenhum cookie de seleção");

  // Sem vínculo, os módulos operacionais continuam fechados, com ou sem o id na URL.
  for (const path of [
    "/conversas",
    `/conversas?organizationId=${f!.orgA}`,
    `/conversas/${f!.conv.c1}`,
    "/fluxos",
    "/contatos",
    "/equipe",
    "/configuracoes",
    `/fluxos/imagens/${f!.orgA}`,
  ]) {
    const page = await platformAdmin.page(path);
    assert.equal(page.redirect, "/sem-organizacao", path);
    assert.doesNotMatch(page.html, /h7 atendente|Mensagem longa/, path);
  }
});

test("central: usuários comuns e organização de outro cliente não entram; identificador manipulado não abre nada", async () => {
  const owner = await loggedIn("aOwner");
  const attendant = await loggedIn("aAttendant");
  const bOwner = await loggedIn("bOwner");
  const anonymous = new Client();

  for (const path of ["/admin", "/admin?busca=org", `/admin/organizacoes/${f!.orgA}`, `/admin/organizacoes/${f!.orgB}`]) {
    for (const client of [owner, attendant, bOwner]) {
      const page = await client.page(path);
      assert.equal(page.redirect, "/visao-geral", path);
      assert.doesNotMatch(page.html, /Org A Integração[\s\S]*Equipe \(|Org B Integração[\s\S]*Equipe \(/, path);
    }
    assert.equal((await anonymous.page(path)).redirect, "/login", path);
  }

  const platformAdmin = await loggedIn("platformAdmin");
  for (const id of [
    "nao-e-uuid",
    "00000000-0000-4000-8000-000000000000",
    "%27%20OR%201%3D1",
    "..%2F..%2Fadmin",
    `${f!.orgA}%20`,
    f!.orgA.toUpperCase().slice(0, 35),
  ]) {
    const page = await platformAdmin.page(`/admin/organizacoes/${id}`);
    assert.equal(page.status, 404, id);
    assert.doesNotMatch(page.html, /Equipe \(/, id);
  }
  // Outro nome de rota ou subcaminho inventado: nada de dados.
  for (const path of [`/admin/organizacoes/${f!.orgA}/conversas`, `/admin/organizacoes/${f!.orgA}/fluxos`, "/admin/conversas"]) {
    assert.equal((await platformAdmin.page(path)).status, 404, path);
  }
});

test("central: suspender e reativar continuam funcionando pelo detalhe, sem tocar nos módulos", async () => {
  const platformAdmin = await loggedIn("platformAdmin");
  const before = await fixture.query("SELECT module::text, enabled FROM public.organization_modules WHERE organization_id = $1 ORDER BY module", [f!.orgC]);

  const active = await platformAdmin.page(`/admin/organizacoes/${f!.orgC}`);
  assert.match(textOf(active.html), /Confirmar suspensão/);
  const suspendId = statusActionIdOf(active.html);
  assert.ok(suspendId, "formulário de suspensão no detalhe");
  try {
    assert.match((await postStatusAction(platformAdmin, suspendId, f!.orgC, "inactive")).text, /Organização suspensa\./);
    assert.equal(await statusOf(f!.orgC), "inactive");
    const suspended = await platformAdmin.page(`/admin/organizacoes/${f!.orgC}`);
    assert.match(textOf(suspended.html), /Organização suspensa/);
    assert.match(textOf(suspended.html), /Reativar/);
    assert.match((await postStatusAction(platformAdmin, suspendId, f!.orgC, "active")).text, /Organização reativada\./);
    assert.equal(await statusOf(f!.orgC), "active");
  } finally {
    await setStatus(f!.orgC, "active");
  }
  const after = await fixture.query("SELECT module::text, enabled FROM public.organization_modules WHERE organization_id = $1 ORDER BY module", [f!.orgC]);
  assert.deepEqual(after.rows, before.rows);
});

