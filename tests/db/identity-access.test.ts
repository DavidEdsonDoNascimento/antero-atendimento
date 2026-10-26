/**
 * Entrega 5A — identidade x autorização: login REAL (handler do Better Auth)
 * → sessão validada → `getActiveContext` → consultas SQL em
 * `withOrganizationTransaction`, exatamente o encadeamento previsto para a
 * Entrega 5B. Estar autenticado não concede acesso a organização nenhuma.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { getValidatedSession } from "../../src/lib/identity/session.ts";
import { createLocalProvisioner } from "../../src/lib/identity/provision.ts";
import { getConversationDetail, listConversations } from "../../src/modules/conversations/sql-queries.ts";
import { getActiveContext, listAllOrganizations } from "../../src/modules/organizations/sql-queries.ts";
import { listOrganizationMembers } from "../../src/modules/users/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import { Browser, createTestIdentity, type TestIdentity } from "./identity-harness.ts";
import {
  createInboxFixtures,
  dropInboxFixtures,
  referenceConversationOrder,
  type InboxFixtures,
} from "./inbox-fixtures.ts";

let identity: TestIdentity;
let fixture: pg.Client;
let f: InboxFixtures | undefined;
const passwords = new Map<string, string>();

type Who = "aOwner" | "aAttendant" | "aDisabled" | "bOwner" | "nobody" | "multi" | "cOwner" | "platformAdmin";

function emailOf(who: Who): string {
  const local: Record<Who, string> = {
    aOwner: "a-owner",
    aAttendant: "a-attendant",
    aDisabled: "a-disabled",
    bOwner: "b-owner",
    nobody: "nobody",
    multi: "multi",
    cOwner: "cowner",
    platformAdmin: "platformadmin",
  };
  return `${local[who]}.${f!.suffix}@teste.local`;
}

function idOf(who: Who): string {
  return who in f!.users ? f!.users[who as keyof InboxFixtures["users"]] : f!.more[who as keyof InboxFixtures["more"]];
}

before(async () => {
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
  // As fixtures criam as identidades sem senha; o provisionamento local dá a
  // cada uma uma credencial (mesmo mecanismo do `pnpm auth:provision`).
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  for (const who of ["aOwner", "aAttendant", "aDisabled", "bOwner", "nobody", "multi", "cOwner", "platformAdmin"] as Who[]) {
    const result = await provisioner.provision({ email: emailOf(who), name: who, rotatePassword: true });
    assert.equal(result.userId, idOf(who));
    passwords.set(who, result.password as string);
  }
});

after(async () => {
  await closeAppPool();
  if (f) await dropInboxFixtures(fixture, f);
  await fixture.end();
  await identity.close();
});

/** Login real e sessão validada: o único caminho para obter o userId. */
async function login(who: Who) {
  const browser = new Browser(identity);
  const response = await browser.signIn(emailOf(who), passwords.get(who)!);
  assert.equal(response.status, 200, `login de ${who}`);
  const session = await getValidatedSession(browser.headers(), identity.auth);
  assert.ok(session, `sessão de ${who}`);
  assert.equal(session.userId, idOf(who));
  return { browser, session };
}

test("dono de A: sessão → organização ativa A (owner) → só as conversas de A", async () => {
  const { session } = await login("aOwner");
  const context = await getActiveContext({ userId: session.userId });
  assert.equal(context?.organization.id, f!.orgA);
  assert.equal(context?.role, "owner");
  assert.equal(context?.profile.id, session.userId);
  const page = await listConversations({ userId: session.userId, organizationId: context!.organization.id }, { limit: 50 });
  assert.deepEqual(
    page.items.map((item) => item.id),
    await referenceConversationOrder(fixture, f!.orgA),
  );
});

test("duas organizações com usuários diferentes: B não alcança A só por estar autenticado", async () => {
  const { session } = await login("bOwner");
  const context = await getActiveContext({ userId: session.userId });
  assert.equal(context?.organization.id, f!.orgB);
  const own = await listConversations({ userId: session.userId, organizationId: f!.orgB }, { limit: 50 });
  assert.deepEqual(
    own.items.map((item) => item.id),
    await referenceConversationOrder(fixture, f!.orgB),
  );
  const cross = { userId: session.userId, organizationId: f!.orgA };
  await assert.rejects(listConversations(cross), AccessDeniedError);
  await assert.rejects(getConversationDetail(cross, f!.conv.c1), AccessDeniedError);
  await assert.rejects(listOrganizationMembers(cross), AccessDeniedError);
});

test("usuário em duas organizações: ativa = vínculo mais antigo (B); A só por contexto explícito válido", async () => {
  const { session } = await login("multi");
  const context = await getActiveContext({ userId: session.userId });
  assert.equal(context?.organization.id, f!.orgB);
  assert.equal(context?.role, "attendant");
  const inA = await listConversations({ userId: session.userId, organizationId: f!.orgA }, { limit: 50 });
  assert.deepEqual(
    inA.items.map((item) => item.id),
    await referenceConversationOrder(fixture, f!.orgA),
  );
  await assert.rejects(listConversations({ userId: session.userId, organizationId: f!.orgC }), AccessDeniedError);
});

test("autenticado sem organização: login funciona, mas não há contexto nem acesso", async () => {
  const { session } = await login("nobody");
  assert.equal(await getActiveContext({ userId: session.userId }), null, "→ /sem-organizacao na 5B");
  for (const organizationId of [f!.orgA, f!.orgB, f!.orgC]) {
    await assert.rejects(listConversations({ userId: session.userId, organizationId }), AccessDeniedError);
  }
});

test("membro desativado: a identidade continua válida, mas o vínculo não vale", async () => {
  const { session } = await login("aDisabled");
  assert.equal(await getActiveContext({ userId: session.userId }), null);
  await assert.rejects(listConversations({ userId: session.userId, organizationId: f!.orgA }), AccessDeniedError);
  await assert.rejects(listOrganizationMembers({ userId: session.userId, organizationId: f!.orgA }), AccessDeniedError);
});

test("atendente ativo de A: contexto A com papel attendant", async () => {
  const { session } = await login("aAttendant");
  const context = await getActiveContext({ userId: session.userId });
  assert.deepEqual([context?.organization.id, context?.role], [f!.orgA, "attendant"]);
});

test("administrador da plataforma: lista organizações, mas não lê a Inbox de quem não é membro", async () => {
  const { session } = await login("platformAdmin");
  assert.equal(await getActiveContext({ userId: session.userId }), null);
  const all = await listAllOrganizations({ userId: session.userId });
  assert.ok([f!.orgA, f!.orgB, f!.orgC].every((id) => all.some((org) => org.id === id)));
  await assert.rejects(listConversations({ userId: session.userId, organizationId: f!.orgA }), AccessDeniedError);
  const notAdmin = await login("aOwner");
  await assert.rejects(listAllOrganizations({ userId: notAdmin.session.userId }), AccessDeniedError);
});

test("logout encerra o caminho: sem sessão não há userId para consultar", async () => {
  const { browser } = await login("cOwner");
  await browser.request("/sign-out", { method: "POST", body: {} });
  assert.equal(await getValidatedSession(browser.headers(), identity.auth), null);
});

test("e-mail/identidade não muda permissões: perfis seguem sem administração da plataforma", async () => {
  const { rows } = await fixture.query(
    "SELECT count(*)::int AS admins FROM public.profiles WHERE id = ANY($1::uuid[]) AND is_platform_admin",
    [[...Object.values(f!.users), f!.more.multi, f!.more.cOwner]],
  );
  assert.equal(rows[0].admins, 0);
});
