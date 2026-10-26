/**
 * Harness dos testes de integração da camada PostgreSQL (src/lib/db).
 *
 * Rode SEMPRE via `pnpm db:test:integration` (scripts/infra.mjs), que monta as
 * URLs do banco de TESTES a partir de .env.infra. Antes de qualquer escrita,
 * este módulo confirma, no cliente e no servidor, que o alvo é o banco
 * descartável:
 *   - host loopback, porta e nome esperados (nome terminado em `_test`);
 *   - as três URLs (aplicação, fixtures, identidade) apontam para o mesmo banco;
 *   - no servidor: banco esperado, `fsync = off` e extensão pgTAP — marcas que
 *     só o banco de testes tem (o de desenvolvimento não tem nenhuma das duas).
 * Se qualquer conferência falhar, nada é escrito.
 *
 * Fixtures: identidades criadas como o Better Auth faria (INSERT em
 * auth.users por antero_auth; o profile nasce por gatilho) e dados de negócio
 * criados por antero_migrator (dono das tabelas). Tudo fictício, com sufixo
 * aleatório, removido no final de cada arquivo.
 */
import { randomBytes } from "node:crypto";

import pg from "pg";

type Target = { role: string; host: string; port: number; database: string };

function parseTarget(name: string): { url: string; target: Target } {
  const url = process.env[name];
  if (!url) {
    throw new Error(`${name} ausente — rode os testes com \`pnpm db:test:integration\`.`);
  }
  const parsed = new URL(url);
  return {
    url,
    target: {
      role: decodeURIComponent(parsed.username),
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.slice(1)),
    },
  };
}

function assertTestTargets() {
  const expectedDatabase = process.env.DB_TEST_EXPECTED_DATABASE ?? "";
  const expectedPort = Number(process.env.DB_TEST_EXPECTED_PORT);
  if (!expectedDatabase.endsWith("_test") || !Number.isInteger(expectedPort)) {
    throw new Error("Ambiente de testes não identificado — use `pnpm db:test:integration`.");
  }
  const app = parseTarget("APP_DATABASE_URL");
  const fixture = parseTarget("DB_TEST_FIXTURE_URL");
  const auth = parseTarget("DB_TEST_AUTH_URL");
  const expectedRoles: Record<string, Target> = {
    antero_app: app.target,
    antero_migrator: fixture.target,
    antero_auth: auth.target,
  };
  for (const [role, target] of Object.entries(expectedRoles)) {
    const ok =
      target.role === role &&
      (target.host === "127.0.0.1" || target.host === "localhost") &&
      target.port === expectedPort &&
      target.database === expectedDatabase;
    if (!ok) {
      throw new Error(`URL de ${role} não aponta para o banco de testes local esperado. Abortado.`);
    }
  }
  return { fixtureUrl: fixture.url, authUrl: auth.url, expectedDatabase };
}

const targets = assertTestTargets();

/** Confirma no servidor que é o banco descartável. Lança se não for. */
async function confirmDisposableDatabase(client: pg.Client) {
  const { rows } = await client.query(`
    SELECT current_database() AS database,
           session_user AS session_role,
           current_setting('fsync') AS fsync,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgtap') AS has_pgtap`);
  const info = rows[0];
  if (
    info.database !== targets.expectedDatabase ||
    info.session_role !== "antero_migrator" ||
    info.fsync !== "off" ||
    info.has_pgtap !== true
  ) {
    throw new Error("O servidor não é o banco de testes descartável (fsync/pgTAP/nome). Abortado.");
  }
}

/** Conexão de fixtures (antero_migrator → antero_owner, ignora RLS). */
export async function connectFixtureClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: targets.fixtureUrl });
  await client.connect();
  try {
    await confirmDisposableDatabase(client);
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}

export type Fixtures = {
  suffix: string;
  orgA: string;
  orgB: string;
  accountA: string;
  accountB: string;
  contactA: string;
  contactB: string;
  conversationA: string;
  conversationB: string;
  users: {
    aOwner: string;
    aAttendant: string;
    aDisabled: string;
    bOwner: string;
    nobody: string;
  };
};

async function createUser(auth: pg.Client, email: string, name: string): Promise<string> {
  const { rows } = await auth.query(
    "INSERT INTO auth.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id",
    [name, email],
  );
  return rows[0].id;
}

/**
 * Identidades extras (como o Better Auth faria: INSERT em auth.users por
 * antero_auth), com o mesmo sufixo das fixtures. Quem cria remove.
 */
export async function createExtraUsers<K extends string>(
  suffix: string,
  names: Record<K, string>,
): Promise<Record<K, string>> {
  const auth = new pg.Client({ connectionString: targets.authUrl });
  await auth.connect();
  try {
    const ids = {} as Record<K, string>;
    for (const [key, name] of Object.entries(names) as [K, string][]) {
      ids[key] = await createUser(auth, `${key.toLowerCase()}.${suffix}@teste.local`, name);
    }
    return ids;
  } finally {
    await auth.end();
  }
}

/**
 * Duas organizações (A e B), cada uma com conta de WhatsApp, contato,
 * conversa e uma mensagem; membros de A em vários papéis/status, dono de B e
 * um usuário sem organização.
 */
export async function createFixtures(fixture: pg.Client): Promise<Fixtures> {
  await confirmDisposableDatabase(fixture);
  const suffix = randomBytes(5).toString("hex");
  const email = (who: string) => `${who}.${suffix}@teste.local`;

  const auth = new pg.Client({ connectionString: targets.authUrl });
  await auth.connect();
  let users: Fixtures["users"];
  try {
    users = {
      aOwner: await createUser(auth, email("a-owner"), "A Owner"),
      aAttendant: await createUser(auth, email("a-attendant"), "A Atendente"),
      aDisabled: await createUser(auth, email("a-disabled"), "A Desativado"),
      bOwner: await createUser(auth, email("b-owner"), "B Owner"),
      nobody: await createUser(auth, email("nobody"), "Sem Organização"),
    };
  } finally {
    await auth.end();
  }

  const one = async (sql: string, values: unknown[]) => (await fixture.query(sql, values)).rows[0].id as string;
  const orgA = await one("INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    "Org A Integração",
    `org-a-${suffix}`,
  ]);
  const orgB = await one("INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    "Org B Integração",
    `org-b-${suffix}`,
  ]);
  await fixture.query(
    `INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
       ($1, $3, 'owner', 'active'), ($1, $4, 'attendant', 'active'), ($1, $5, 'admin', 'disabled'),
       ($2, $6, 'owner', 'active')`,
    [orgA, orgB, users.aOwner, users.aAttendant, users.aDisabled, users.bOwner],
  );
  const account = (org: string, label: string) =>
    one(
      `INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
       VALUES ($1, 'development', 'connected', $2) RETURNING id`,
      [org, label],
    );
  const accountA = await account(orgA, `Canal A ${suffix}`);
  const accountB = await account(orgB, `Canal B ${suffix}`);
  const contact = (org: string, phone: string) =>
    one("INSERT INTO public.contacts (organization_id, phone_number, name) VALUES ($1, $2, $3) RETURNING id", [
      org,
      phone,
      `Contato ${suffix}`,
    ]);
  const contactA = await contact(orgA, "+5511955550001");
  const contactB = await contact(orgB, "+5511955550002");
  const conversation = (org: string, acc: string, ct: string) =>
    one(
      `INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [org, acc, ct],
    );
  const conversationA = await conversation(orgA, accountA, contactA);
  const conversationB = await conversation(orgB, accountB, contactB);
  const message = (org: string, conv: string, acc: string, content: string) =>
    fixture.query(
      `INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, content)
       VALUES ($1, $2, $3, 'inbound', 'contact', $4)`,
      [org, conv, acc, content],
    );
  await message(orgA, conversationA, accountA, "mensagem da org A");
  await message(orgB, conversationB, accountB, "mensagem da org B");

  return {
    suffix,
    orgA,
    orgB,
    accountA,
    accountB,
    contactA,
    contactB,
    conversationA,
    conversationB,
    users,
  };
}

/** Remove tudo o que createFixtures criou (ordem respeita as FKs RESTRICT). */
export async function dropFixtures(fixture: pg.Client, f: Fixtures): Promise<void> {
  await confirmDisposableDatabase(fixture);
  const orgs = [f.orgA, f.orgB];
  await fixture.query("BEGIN");
  try {
    await fixture.query("DELETE FROM public.messages WHERE organization_id = ANY($1::uuid[])", [orgs]);
    await fixture.query("DELETE FROM public.conversations WHERE organization_id = ANY($1::uuid[])", [orgs]);
    await fixture.query("DELETE FROM public.contacts WHERE organization_id = ANY($1::uuid[])", [orgs]);
    await fixture.query("DELETE FROM public.whatsapp_accounts WHERE organization_id = ANY($1::uuid[])", [orgs]);
    await fixture.query("DELETE FROM public.organizations WHERE id = ANY($1::uuid[])", [orgs]);
    await fixture.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [Object.values(f.users)]);
    await fixture.query("COMMIT");
  } catch (error) {
    await fixture.query("ROLLBACK");
    throw error;
  }
}

/** Uma conexão avulsa como antero_app, FORA da camada (para simular mau uso). */
export function rawAppClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
}
