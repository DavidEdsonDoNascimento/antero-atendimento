import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAppDatabaseConfig, parseWorkerDatabaseConfig } from "./config.ts";
import { DatabaseConfigError } from "./errors.ts";

const SECRET = "senha-ficticia-nao-real-123";
const VALID_URL = `postgres://antero_app:${SECRET}@127.0.0.1:55434/antero_atendimentos_test`;

function expectConfigError(env: Record<string, string | undefined>, pattern: RegExp) {
  assert.throws(
    () => parseAppDatabaseConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseConfigError);
      assert.match(error.message, pattern);
      // Nunca vaza a senha nem a URL.
      assert.ok(!error.message.includes(SECRET), "mensagem não pode conter a senha");
      assert.ok(!error.message.includes("@127.0.0.1"), "mensagem não pode conter a URL");
      return true;
    },
  );
}

test("config: URL válida do antero_app com padrões", () => {
  const config = parseAppDatabaseConfig({ APP_DATABASE_URL: VALID_URL });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 55434);
  assert.equal(config.database, "antero_atendimentos_test");
  assert.equal(config.poolMax, 10);
  assert.equal(config.connectTimeoutMs, 5000);
  assert.equal(config.idleTimeoutMs, 30000);
  assert.equal(config.statementTimeoutMs, 15000);
  assert.equal(config.idleInTransactionTimeoutMs, 60000);
});

test("config: limites customizados e sslmode aceitos", () => {
  const config = parseAppDatabaseConfig({
    APP_DATABASE_URL: `${VALID_URL}?sslmode=require`,
    APP_DATABASE_POOL_MAX: "1",
    APP_DATABASE_CONNECT_TIMEOUT_MS: "2000",
    APP_DATABASE_IDLE_TIMEOUT_MS: "1000",
    APP_DATABASE_STATEMENT_TIMEOUT_MS: "500",
  });
  assert.equal(config.poolMax, 1);
  assert.equal(config.connectTimeoutMs, 2000);
  assert.equal(config.idleTimeoutMs, 1000);
  assert.equal(config.statementTimeoutMs, 500);
});

test("config: variáveis vazias usam o padrão", () => {
  const config = parseAppDatabaseConfig({ APP_DATABASE_URL: VALID_URL, APP_DATABASE_POOL_MAX: "" });
  assert.equal(config.poolMax, 10);
});

test("config: URL ausente é rejeitada", () => {
  expectConfigError({}, /APP_DATABASE_URL é obrigatória/);
});

test("config: papéis que não são antero_app são rejeitados", () => {
  for (const role of ["antero_admin", "antero_owner", "antero_migrator", "antero_auth", "postgres"]) {
    expectConfigError(
      { APP_DATABASE_URL: `postgres://${role}:${SECRET}@127.0.0.1:55434/db` },
      /papel antero_app/,
    );
  }
});

test("config: senha ausente, esquema errado e URL inválida são rejeitados", () => {
  expectConfigError({ APP_DATABASE_URL: "postgres://antero_app@127.0.0.1:5432/db" }, /senha/);
  expectConfigError({ APP_DATABASE_URL: `mysql://antero_app:${SECRET}@127.0.0.1/db` }, /postgres:\/\//);
  expectConfigError({ APP_DATABASE_URL: "não é url" }, /URL válida/);
  expectConfigError({ APP_DATABASE_URL: `postgres://antero_app:${SECRET}@127.0.0.1:5432/` }, /nome do banco/);
});

test("config: parâmetros de URL que mudam papel/sessão são rejeitados", () => {
  for (const param of ["options=-c%20row_security%3Doff", "user=antero_admin", "host=outro", "application_name=x"]) {
    expectConfigError({ APP_DATABASE_URL: `${VALID_URL}?${param}` }, /não é permitido/);
  }
});

test("config: limites fora da faixa ou não inteiros são rejeitados", () => {
  expectConfigError({ APP_DATABASE_URL: VALID_URL, APP_DATABASE_POOL_MAX: "0" }, /no mínimo 1/);
  expectConfigError({ APP_DATABASE_URL: VALID_URL, APP_DATABASE_POOL_MAX: "51" }, /no máximo 50/);
  expectConfigError({ APP_DATABASE_URL: VALID_URL, APP_DATABASE_POOL_MAX: "2.5" }, /inteiro/);
  expectConfigError({ APP_DATABASE_URL: VALID_URL, APP_DATABASE_CONNECT_TIMEOUT_MS: "-1" }, /inteiro/);
});

const WORKER_URL = `postgres://antero_worker:${SECRET}@127.0.0.1:55434/antero_atendimentos_test`;

function expectWorkerConfigError(env: Record<string, string | undefined>, pattern: RegExp) {
  assert.throws(
    () => parseWorkerDatabaseConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseConfigError);
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(SECRET), "mensagem não pode conter a senha");
      assert.ok(!error.message.includes("@127.0.0.1"), "mensagem não pode conter a URL");
      return true;
    },
  );
}

test("config do worker: URL do antero_worker com padrões menores que os da aplicação", () => {
  const config = parseWorkerDatabaseConfig({ WORKER_DATABASE_URL: WORKER_URL });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.database, "antero_atendimentos_test");
  assert.equal(config.poolMax, 3);
  assert.equal(config.connectTimeoutMs, 3000);
  assert.equal(config.statementTimeoutMs, 10000);
  assert.equal(config.idleInTransactionTimeoutMs, 60000);
});

test("config do worker: variáveis próprias, sem ler as da aplicação", () => {
  const config = parseWorkerDatabaseConfig({
    WORKER_DATABASE_URL: WORKER_URL,
    WORKER_DATABASE_POOL_MAX: "2",
    APP_DATABASE_POOL_MAX: "40",
  });
  assert.equal(config.poolMax, 2);
  expectWorkerConfigError({ APP_DATABASE_URL: VALID_URL }, /WORKER_DATABASE_URL é obrigatória/);
  expectWorkerConfigError({ WORKER_DATABASE_URL: WORKER_URL, WORKER_DATABASE_POOL_MAX: "0" }, /WORKER_DATABASE_POOL_MAX deve ser no mínimo 1/);
});

test("config do worker: só o papel antero_worker (nem a aplicação, nem dono, nem superusuário)", () => {
  for (const role of ["antero_app", "antero_admin", "antero_owner", "antero_migrator", "antero_auth", "postgres"]) {
    expectWorkerConfigError({ WORKER_DATABASE_URL: `postgres://${role}:${SECRET}@127.0.0.1:55434/db` }, /papel antero_worker/);
  }
  expectWorkerConfigError({ WORKER_DATABASE_URL: `${WORKER_URL}?options=-c%20role%3Dantero_owner` }, /não é permitido/);
  // E a aplicação continua recusando o papel do worker.
  expectConfigError({ APP_DATABASE_URL: WORKER_URL }, /papel antero_app/);
});
