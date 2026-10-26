/**
 * Entrega 5B — integração da aplicação com a identidade e as consultas SQL,
 * sem servidor HTTP (o ponta a ponta está em tests/e2e):
 *   - a rota montada pelo Next (`app/api/auth/[...all]/route.ts`) com a
 *     instância da aplicação (`getIdentityAuth`, variáveis do ambiente):
 *     rate limit, origem, cadastro desligado;
 *   - 5xx do Better Auth normalizados para 503 neutro;
 *   - loaders da Inbox e perfil próprio com o contexto do DAL;
 *   - nenhum código da aplicação chama `auth.api.*` (o que escaparia do rate limit).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { GET, POST } from "../../src/app/api/auth/[...all]/route.ts";
import { loadConversationList, loadConversationMessages } from "../../src/app/(platform)/conversas/_lib/loaders.ts";
import { AccessDeniedError, InvalidUserContextError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { closeIdentity } from "../../src/lib/identity/auth.ts";
import { handleIdentityRequest } from "../../src/lib/identity/handler.ts";
import { getOwnProfile } from "../../src/modules/users/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import { createTestIdentity, dropUsers, provisionUsers, uniqueIp, type ProvisionedUser, type TestIdentity } from "./identity-harness.ts";
import { createInboxFixtures, dropInboxFixtures, referenceConversationOrder, type InboxFixtures } from "./inbox-fixtures.ts";

const ORIGIN = process.env.BETTER_AUTH_URL as string;

let identity: TestIdentity;
let fixture: pg.Client;
let f: InboxFixtures | undefined;
let user: ProvisionedUser;

before(async () => {
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
  user = (await provisionUsers(identity, { rota: "Rota Real" })).users.rota;
});

after(async () => {
  await dropUsers([user.userId]);
  if (f) await dropInboxFixtures(fixture, f);
  await fixture.end();
  await identity.close();
  await closeIdentity();
  await closeAppPool();
});

function routeRequest(path: string, body: unknown, { ip = uniqueIp(), origin = ORIGIN }: { ip?: string; origin?: string } = {}) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

test("rota real /api/auth: login, rate limit no 6º pedido do mesmo IP, origem externa e cadastro", async () => {
  const ok = await POST(routeRequest("/sign-in/email", { email: user.email, password: user.password }));
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.getSetCookie().some((cookie) => cookie.startsWith("antero.session_token=")));

  const ip = uniqueIp();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const wrong = await POST(routeRequest("/sign-in/email", { email: user.email, password: `errada-${attempt}-1` }, { ip }));
    assert.equal(wrong.status, 401, `tentativa ${attempt}`);
  }
  const blocked = await POST(routeRequest("/sign-in/email", { email: user.email, password: user.password }, { ip }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.getSetCookie().length, 0);

  const foreign = await POST(
    routeRequest("/sign-in/email", { email: user.email, password: user.password }, { origin: "https://atacante.exemplo" }),
  );
  assert.equal(foreign.status, 403);

  const signUp = await POST(routeRequest("/sign-up/email", { email: "novo@teste.local", password: "senha-123456", name: "x" }));
  assert.equal(signUp.status, 404);

  const session = await GET(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { "x-forwarded-for": uniqueIp() } }));
  assert.equal(session.status, 200);
  assert.equal(await session.json(), null);
});

test("handler: qualquer 5xx do Better Auth vira 503 neutro, sem cookie e sem a mensagem interna", async () => {
  const leaky = {
    handler: async () =>
      new Response(JSON.stringify({ message: "connect ECONNREFUSED 127.0.0.1:55433" }), {
        status: 500,
        headers: { "set-cookie": "antero.session_token=x.y; Path=/" },
      }),
  } as unknown as Parameters<typeof handleIdentityRequest>[1];
  const response = await handleIdentityRequest(new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST" }), leaky);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: "Serviço de autenticação indisponível. Tente novamente." });
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("perfil próprio (DAL): só pelo id da sessão; id inválido é recusado antes do banco", async () => {
  const profile = await getOwnProfile({ userId: f!.users.aOwner });
  assert.equal(profile?.id, f!.users.aOwner);
  assert.equal(profile?.is_platform_admin, false);
  assert.equal((await getOwnProfile({ userId: f!.more.platformAdmin }))?.is_platform_admin, true);
  await assert.rejects(getOwnProfile({ userId: "nao-e-uuid" }), InvalidUserContextError);
});

test("loaders da Inbox com o contexto do DAL: cursor adulterado volta à 1ª página; outra empresa é negada", async () => {
  const context = { userId: f!.users.aOwner, organizationId: f!.orgA };
  const expected = await referenceConversationOrder(fixture, f!.orgA);
  const first = await loadConversationList(context, undefined, undefined);
  assert.deepEqual(first.items.map((item) => item.id), expected.slice(0, first.items.length));
  const fallback = await loadConversationList(context, undefined, "cursor-adulterado");
  assert.deepEqual(fallback.items.map((item) => item.id), first.items.map((item) => item.id));

  const history = await loadConversationMessages(context, f!.conv.cH, "cursor-adulterado");
  assert.deepEqual(history.items.map((item) => item.id), f!.historyIds);
  // Conversa de outra organização: histórico vazio (o detalhe já a trata como inexistente).
  assert.deepEqual(await loadConversationMessages(context, f!.conv.cB2, undefined), { items: [], nextCursor: null });

  await assert.rejects(
    loadConversationList({ userId: f!.users.aOwner, organizationId: f!.orgB }, undefined, undefined),
    AccessDeniedError,
  );
  await assert.rejects(
    loadConversationList({ userId: f!.users.aDisabled, organizationId: f!.orgA }, undefined, undefined),
    AccessDeniedError,
  );
});

test("nenhum código da aplicação usa auth.api.* ou a instância do Better Auth fora de src/lib/identity", () => {
  const root = new URL("../../src/", import.meta.url).pathname;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!path.endsWith("/lib/identity")) walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        // Só código: comentários podem citar `auth.api` para explicar a regra.
        const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/\bauth\.api\b|getIdentityAuth|createIdentityAuth|signInEmail|"use server"/.test(source)) offenders.push(path);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
