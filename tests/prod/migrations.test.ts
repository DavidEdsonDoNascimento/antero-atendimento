/**
 * Entrega 7A — procedimento de migrations da imagem de produção (`pnpm
 * homolog:prod migrations`): alvo `migrate` do Dockerfile (dbmate +
 * db/migrations), papel `antero_migrator`, idempotência, falha explícita e
 * isolamento das credenciais. Só o banco DESCARTÁVEL de homologação.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import pg from "pg";

const IMAGE = "antero-atendimentos/migrate:homolog";
const NETWORK = "antero-atendimentos-homolog-backend";
const APP = "antero-atendimentos-homolog-app";
const fixtureUrl = new URL(process.env.DB_TEST_FIXTURE_URL as string);
const migratorPassword = decodeURIComponent(fixtureUrl.password);
const database = fixtureUrl.pathname.slice(1);
const dbUrl = (password = migratorPassword) =>
  `postgres://antero_migrator:${password}@antero-atendimentos-homolog-db:5432/${database}?sslmode=disable`;

let admin: pg.Client;
const scratch = mkdtempSync(join(tmpdir(), "antero-migrations-"));

function dbmate(command: string, { url = dbUrl(), dir }: { url?: string; dir?: string } = {}) {
  // DBMATE_WAIT=false: no teste, falha de credencial deve ser imediata.
  const args = ["run", "--rm", "--network", NETWORK, "-e", `DATABASE_URL=${url}`, "-e", "DBMATE_WAIT=false"];
  if (dir) args.push("-v", `${dir}:/db/migrations:ro`);
  const result = spawnSync("docker", [...args, IMAGE, command], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

before(async () => {
  admin = new pg.Client({ connectionString: process.env.HOMOLOG_ADMIN_URL });
  await admin.connect();
});
after(async () => {
  await admin.end();
  rmSync(scratch, { recursive: true, force: true });
});

const applied = async () => (await admin.query("select version from public.schema_migrations order by 1")).rows.map((r) => r.version);

test("up é idempotente: segunda execução não reaplica nada e sai com 0", async () => {
  const before = await applied();
  assert.deepEqual(before, ["0000", "0001", "0002", "0003", "0004", "0005"]);
  const again = dbmate("up");
  assert.equal(again.status, 0, again.out);
  assert.doesNotMatch(again.out, /Applying|Applied/);
  assert.deepEqual(await applied(), before);
  const status = dbmate("status");
  assert.equal(status.status, 0);
  assert.match(status.out, /Applied: 6/);
  assert.match(status.out, /Pending: 0/);
});

test("migration com erro: falha explícita (≠ 0), nada aplicado, sem reset nem DROP", async () => {
  const dir = join(scratch, "migrations");
  cpSync(join(process.cwd(), "db", "migrations"), dir, { recursive: true });
  writeFileSync(join(dir, "9999_quebrada.sql"), "-- migrate:up\ncreate table public.homolog_tabela_parcial (id int);\nselect 1/0;\n-- migrate:down\ndrop table public.homolog_tabela_parcial;\n");
  const tablesBefore = (await admin.query("select count(*)::int as n from information_schema.tables where table_schema in ('public','auth')")).rows[0].n;

  const result = dbmate("up", { dir });
  assert.notEqual(result.status, 0, "a falha precisa ser visível ao pipeline");
  assert.match(result.out, /division by zero/i);
  assert.ok(!(await applied()).includes("9999"));
  // Transação por migration: a tabela criada antes do erro não ficou.
  const leftover = await admin.query("select to_regclass('public.homolog_tabela_parcial') as t");
  assert.equal(leftover.rows[0].t, null);
  const tablesAfter = (await admin.query("select count(*)::int as n from information_schema.tables where table_schema in ('public','auth')")).rows[0].n;
  assert.equal(tablesAfter, tablesBefore, "o schema existente permaneceu intacto");
});

test("credencial errada ou papel da aplicação não migra: falha explícita", async () => {
  assert.notEqual(dbmate("up", { url: dbUrl("senha-errada") }).status, 0);
  const asApp = new URL(dbUrl());
  asApp.username = "antero_app";
  asApp.password = decodeURIComponent(new URL(process.env.APP_DATABASE_URL as string).password);
  const before = await applied();
  const result = dbmate("up", { url: asApp.toString() });
  // antero_app não é dono de nada e não pode criar objetos: não consegue migrar.
  assert.notEqual(result.status, 0, result.out);
  assert.deepEqual(await applied(), before);
});

test("o contêiner da aplicação não recebe credenciais administrativas nem a do migrador", async () => {
  const env = spawnSync("docker", ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", APP], { encoding: "utf8" }).stdout;
  const adminPassword = decodeURIComponent(new URL(process.env.HOMOLOG_ADMIN_URL as string).password);
  assert.ok(!env.includes(adminPassword), "senha de antero_admin ausente");
  assert.ok(!env.includes(migratorPassword), "senha de antero_migrator ausente");
  assert.doesNotMatch(env, /antero_admin|antero_migrator|antero_owner/);
  assert.match(env, /APP_DATABASE_URL=postgres:\/\/antero_app:/);
  assert.match(env, /AUTH_DATABASE_URL=postgres:\/\/antero_auth:/);
  // A aplicação sobe e atende sem executar migrations por conta própria.
  const logs = spawnSync("docker", ["logs", APP], { encoding: "utf8" });
  assert.doesNotMatch(`${logs.stdout}${logs.stderr}`, /dbmate|migrat/i);
});
