/**
 * Entrega 5A — fundação da identidade: schema x configuração real do Better
 * Auth 1.7.12, ids UUID, pools e papéis separados, perfil automático,
 * cadastro público bloqueado e provisionamento local.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { APIError } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type pg from "pg";

import { closeAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import { parseAppDatabaseConfig } from "../../src/lib/db/config.ts";
import { IdentityConfigError, ProvisioningRefusedError } from "../../src/lib/identity/errors.ts";
import { buildIdentityAuthOptions } from "../../src/lib/identity/options.ts";
import { createIdentityPool } from "../../src/lib/identity/pool.ts";
import { assertLocalProvisioningTarget, createLocalProvisioner } from "../../src/lib/identity/provision.ts";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let identity: TestIdentity;
let fixture: pg.Client;
let suffix = "";
let users: Record<"dora" | "ivo", ProvisionedUser>;
const extraUserIds: string[] = [];

before(async () => {
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  ({ suffix, users } = await provisionUsers(identity, { dora: "Dora Teste", ivo: "Ivo Teste" }));
});

after(async () => {
  await fixture.query("ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS teste_perfil_recusado");
  await dropUsers([...Object.values(users ?? {}).map((user) => user.userId), ...extraUserIds]);
  // Rede de segurança: se um teste negativo falhar (ex.: cadastro que deveria
  // ser recusado), nada com o sufixo desta execução fica no banco.
  if (suffix) await fixture.query("DELETE FROM auth.users WHERE email LIKE $1", [`%.${suffix}@teste.local`]);
  await closeAppPool();
  await fixture.end();
  await identity.close();
});

test("schema auth = configuração REAL de runtime (planejador oficial do Better Auth não gera nada)", async () => {
  const options = buildIdentityAuthOptions({
    config: identity.config,
    pool: identity.pool,
    mailer: { async sendPasswordReset() {}, close() {} },
    logSink: () => {},
  });
  const plan = await getMigrations(options);
  assert.deepEqual(plan.toBeCreated, [], "nenhuma tabela a criar (rate limit em memória, sem plugins)");
  assert.deepEqual(plan.toBeAdded, [], "nenhuma coluna a acrescentar");
  assert.equal(await plan.compileMigrations(), ";");
});

test("ids UUID em users/sessions/accounts e referência compatível com profiles", async () => {
  await new Browser(identity).signIn(users.dora.email, users.dora.password);
  const { rows } = await fixture.query(
    `SELECT u.id AS user_id, s.id AS session_id, s.user_id AS session_user, a.id AS account_id,
            a.user_id AS account_user, a.account_id, a.provider_id, p.id AS profile_id
     FROM auth.users u
     JOIN auth.sessions s ON s.user_id = u.id
     JOIN auth.accounts a ON a.user_id = u.id
     JOIN public.profiles p ON p.id = u.id
     WHERE u.id = $1`,
    [users.dora.userId],
  );
  assert.ok(rows.length >= 1);
  const row = rows[0];
  for (const key of ["user_id", "session_id", "account_id", "profile_id"]) assert.match(row[key], UUID, key);
  assert.equal(row.session_user, users.dora.userId);
  assert.equal(row.account_user, users.dora.userId);
  assert.equal(row.profile_id, users.dora.userId);
  assert.deepEqual([row.provider_id, row.account_id], ["credential", users.dora.userId]);
});

test("pools separados: identidade conecta como antero_auth, aplicação como antero_app", async () => {
  const identityRole = (await identity.pool.query("SELECT current_user AS role, session_user AS session")).rows[0];
  assert.deepEqual(identityRole, { role: "antero_auth", session: "antero_auth" });
  const appRole = await withUserTransaction(users.dora.userId, async (tx) =>
    (await tx.query<{ role: string }>("SELECT current_user AS role")).rows[0].role,
  );
  assert.equal(appRole, "antero_app");
  assert.notEqual(identity.config.database.connectionString, process.env.APP_DATABASE_URL);
});

test("cada configuração recusa o papel da outra", () => {
  assert.throws(
    () => testIdentityConfig({ AUTH_DATABASE_URL: process.env.APP_DATABASE_URL as string }),
    IdentityConfigError,
  );
  assert.throws(() => parseAppDatabaseConfig({ APP_DATABASE_URL: process.env.AUTH_DATABASE_URL }), /antero_app/);
});

test("o pool da identidade descarta conexão de outro papel (verificação no servidor)", async () => {
  const wrong = createIdentityPool({
    ...identity.config.database,
    connectionString: process.env.APP_DATABASE_URL as string,
  });
  try {
    await assert.rejects(wrong.query("SELECT 1"), IdentityConfigError);
  } finally {
    await wrong.end();
  }
});

test("antero_auth não tem privilégio algum em tabelas, sequências e funções de negócio", async () => {
  const { rows } = await identity.pool.query(`
    SELECT n.nspname || '.' || c.relname AS object
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'v', 'm', 'S', 'p')
      -- objetos de extensões (as views do pgTAP só existem no banco de testes)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      AND (has_table_privilege(c.oid, 'SELECT') OR has_table_privilege(c.oid, 'INSERT')
           OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE')
           OR has_table_privilege(c.oid, 'TRUNCATE') OR has_table_privilege(c.oid, 'REFERENCES')
           OR has_table_privilege(c.oid, 'TRIGGER'))
    UNION ALL
    SELECT n.nspname || '.' || p.proname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'app')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      AND has_function_privilege(p.oid, 'EXECUTE')`);
  assert.deepEqual(rows, []);
  for (const sql of [
    "SELECT * FROM public.profiles",
    "SELECT * FROM public.organizations",
    "SELECT * FROM public.conversations",
    "INSERT INTO public.organization_members (organization_id, user_id) VALUES (gen_random_uuid(), gen_random_uuid())",
    "UPDATE public.profiles SET is_platform_admin = true",
    "SELECT public.is_platform_admin()",
    "SELECT app.set_user_context(gen_random_uuid())",
  ]) {
    await assert.rejects(identity.pool.query(sql), { code: "42501" }, sql);
  }
});

test("antero_app não lê credenciais nem sessões (schema auth)", async () => {
  for (const sql of [
    "SELECT password FROM auth.accounts",
    "SELECT token FROM auth.sessions",
    "SELECT value FROM auth.verifications",
    "SELECT email FROM auth.users",
  ]) {
    await assert.rejects(withUserTransaction(users.dora.userId, (tx) => tx.query(sql)), { code: "42501" }, sql);
  }
});

test("perfil criado automaticamente, sem administração da plataforma", async () => {
  const { rows } = await fixture.query(
    "SELECT email, full_name, is_platform_admin FROM public.profiles WHERE id = $1",
    [users.ivo.userId],
  );
  assert.deepEqual(rows[0], { email: users.ivo.email, full_name: "Ivo Teste", is_platform_admin: false });
});

test("troca de e-mail na identidade sincroniza o perfil; o nome do perfil não é sobrescrito", async () => {
  const ctx = await identity.auth.$context;
  const newEmail = `ivo.novo.${suffix}@teste.local`;
  await ctx.internalAdapter.updateUser(users.ivo.userId, { email: newEmail, name: "Outro Nome" });
  const { rows } = await fixture.query("SELECT email, full_name FROM public.profiles WHERE id = $1", [users.ivo.userId]);
  assert.deepEqual(rows[0], { email: newEmail, full_name: "Ivo Teste" });
  users.ivo.email = newEmail;
});

test("falha ao criar o perfil desfaz a identidade inteira (sem usuário sem perfil)", async () => {
  // Só no banco descartável: recusa temporária de perfis com este prefixo.
  await fixture.query(
    `ALTER TABLE public.profiles ADD CONSTRAINT teste_perfil_recusado
     CHECK (email NOT LIKE 'perfil-recusado.%') NOT VALID`,
  );
  const email = `perfil-recusado.${suffix}@teste.local`;
  try {
    const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
    await assert.rejects(provisioner.provision({ email, name: "Perfil Recusado" }));
  } finally {
    await fixture.query("ALTER TABLE public.profiles DROP CONSTRAINT teste_perfil_recusado");
  }
  const { rows } = await fixture.query(
    `SELECT (SELECT count(*)::int FROM auth.users WHERE email = $1) AS users,
            (SELECT count(*)::int FROM auth.accounts a JOIN auth.users u ON u.id = a.user_id WHERE u.email = $1) AS accounts,
            (SELECT count(*)::int FROM public.profiles WHERE email = $1) AS profiles`,
    [email],
  );
  assert.deepEqual(rows[0], { users: 0, accounts: 0, profiles: 0 });
});

test("cadastro público bloqueado: rota HTTP desligada e API do servidor recusa", async () => {
  const email = `cadastro.${suffix}@teste.local`;
  const response = await new Browser(identity).request("/sign-up/email", {
    body: { email, password: "senha-cadastro-123", name: "Cadastro" },
  });
  assert.equal(response.status, 404);
  await assert.rejects(
    identity.auth.api.signUpEmail({ body: { email, password: "senha-cadastro-123", name: "Cadastro" } }),
    (error) => error instanceof APIError && (error.body as { code?: string })?.code === "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  );
  assert.equal((await fixture.query("SELECT 1 FROM auth.users WHERE email = $1", [email])).rowCount, 0);
});

test("sem autopromoção: rotas de alteração de conta desligadas e nenhum campo de papel na identidade", async () => {
  const browser = new Browser(identity);
  await browser.signIn(users.dora.email, users.dora.password);
  for (const [path, body] of [
    ["/update-user", { name: "Admin", isPlatformAdmin: true, is_platform_admin: true }],
    ["/change-email", { newEmail: `outro.${suffix}@teste.local` }],
    ["/delete-user", {}],
    ["/link-social", { provider: "google" }],
  ] as const) {
    assert.equal((await browser.request(path, { body })).status, 404, path);
  }
  const session = (await (await browser.request("/get-session")).json()) as { user: Record<string, unknown> };
  assert.deepEqual(Object.keys(session.user).sort(), ["createdAt", "email", "emailVerified", "id", "image", "name", "updatedAt"]);
  const { rows } = await fixture.query("SELECT is_platform_admin FROM public.profiles WHERE id = $1", [users.dora.userId]);
  assert.equal(rows[0].is_platform_admin, false);
});

test("provisionamento: repetível por e-mail, sem duplicar; rotação troca a senha e encerra sessões", async () => {
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  const again = await provisioner.provision({ email: users.dora.email.toUpperCase(), name: "Outro" });
  assert.deepEqual(again, { userId: users.dora.userId, email: users.dora.email, created: false, password: null });
  const counts = await fixture.query(
    `SELECT (SELECT count(*)::int FROM auth.users WHERE email = $1) AS users,
            (SELECT count(*)::int FROM auth.accounts WHERE user_id = $2) AS accounts`,
    [users.dora.email, users.dora.userId],
  );
  assert.deepEqual(counts.rows[0], { users: 1, accounts: 1 });

  const browser = new Browser(identity);
  assert.equal((await browser.signIn(users.dora.email, users.dora.password)).status, 200);
  const rotated = await provisioner.provision({ email: users.dora.email, name: "x", rotatePassword: true });
  assert.ok(rotated.password && rotated.password !== users.dora.password);
  assert.equal((await new Browser(identity).signIn(users.dora.email, users.dora.password)).status, 401);
  assert.equal((await new Browser(identity).signIn(users.dora.email, rotated.password)).status, 200);
  assert.equal(await (await browser.request("/get-session")).json(), null, "sessões anteriores encerradas");
  users.dora.password = rotated.password;

  const hash = (await fixture.query("SELECT password FROM auth.accounts WHERE user_id = $1", [users.dora.userId]))
    .rows[0].password as string;
  assert.ok(!hash.includes(rotated.password), "senha nunca em texto puro");
  assert.match(hash, /^[0-9a-f]+:[0-9a-f]+$/, "formato salt:hash (scrypt do Better Auth)");
});

test("provisionamento recusa produção, banco remoto e origem remota", () => {
  const local = identity.config;
  assert.throws(() => assertLocalProvisioningTarget(local, { NODE_ENV: "production" }), ProvisioningRefusedError);
  assert.throws(
    () => assertLocalProvisioningTarget({ ...local, database: { ...local.database, host: "db.exemplo.com" } }, {}),
    ProvisioningRefusedError,
  );
  assert.throws(
    () => assertLocalProvisioningTarget({ ...local, baseURL: "https://atendimento.exemplo.com" }, {}),
    ProvisioningRefusedError,
  );
  assert.doesNotThrow(() => assertLocalProvisioningTarget(local, {}));
});

test("provisionamento valida os dados e não aceita senha curta", async () => {
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  await assert.rejects(provisioner.provision({ email: "invalido", name: "x" }), ProvisioningRefusedError);
  await assert.rejects(
    provisioner.provision({ email: `curta.${suffix}@teste.local`, name: "x", password: "curta" }),
    ProvisioningRefusedError,
  );
  const created = await provisioner.provision({ email: ` Espacos.${suffix}@Teste.Local `, name: "  Espaços  " });
  extraUserIds.push(created.userId);
  assert.equal(created.email, `espacos.${suffix}@teste.local`);
  assert.equal(created.created, true);
  assert.equal(created.password?.length, 24);
});
