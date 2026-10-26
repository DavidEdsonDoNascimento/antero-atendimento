#!/usr/bin/env node
// Operações da infraestrutura LOCAL do Antero Atendimentos.
//
// Todo comando passa por aqui (via `pnpm infra:*` e `pnpm db:*`) para aplicar
// as mesmas proteções:
//   - o projeto Compose é sempre `antero-atendimentos` e o arquivo é sempre
//     `compose.yaml` — nunca o de outro projeto;
//   - a configuração vem só de `.env.infra`; variáveis do shell que o Compose
//     usaria para interpolar (e DATABASE_URL/DBMATE_*/PG*) são descartadas;
//   - recusa Docker remoto, configuração ausente e senhas fracas;
//   - o banco de testes só aceita nomes terminados em `_test`;
//   - não existe comando que apague o volume do banco de desenvolvimento.
//
// Sem dependências além do Node e do CLI do Docker. Nunca imprime senhas.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "antero-atendimentos";
const COMPOSE_FILE = join(ROOT, "compose.yaml");
const ENV_FILE = join(ROOT, ".env.infra");
const ENV_EXAMPLE = join(ROOT, ".env.infra.example");

const PASSWORD_KEYS = [
  "DEV_ADMIN_PASSWORD",
  "DEV_MIGRATOR_PASSWORD",
  "DEV_APP_PASSWORD",
  "DEV_AUTH_PASSWORD",
  "TEST_ADMIN_PASSWORD",
  "TEST_MIGRATOR_PASSWORD",
  "TEST_APP_PASSWORD",
  "TEST_AUTH_PASSWORD",
];
const REQUIRED_KEYS = [
  "DEV_DB_PORT",
  "TEST_DB_PORT",
  "MAILPIT_SMTP_PORT",
  "MAILPIT_UI_PORT",
  "DEV_DB_NAME",
  "TEST_DB_NAME",
  ...PASSWORD_KEYS,
];
const MIGRATE_COMMANDS = new Set(["up", "status", "rollback", "wait"]);

function fail(message) {
  console.error(`[infra] ERRO: ${message}`);
  process.exit(1);
}

function parseEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

function loadConfig() {
  if (!existsSync(ENV_FILE)) {
    fail(".env.infra não existe. Rode `pnpm infra:env` para gerá-lo.");
  }
  const cfg = parseEnvFile(ENV_FILE);

  const missing = REQUIRED_KEYS.filter((key) => !cfg[key]);
  if (missing.length > 0) {
    fail(`variáveis ausentes ou vazias em .env.infra: ${missing.join(", ")}`);
  }

  for (const key of ["DEV_DB_PORT", "TEST_DB_PORT", "MAILPIT_SMTP_PORT", "MAILPIT_UI_PORT"]) {
    if (!/^\d{2,5}$/.test(cfg[key]) || Number(cfg[key]) > 65535) {
      fail(`${key} não é uma porta válida.`);
    }
  }
  const ports = ["DEV_DB_PORT", "TEST_DB_PORT", "MAILPIT_SMTP_PORT", "MAILPIT_UI_PORT"].map(
    (k) => cfg[k],
  );
  if (new Set(ports).size !== ports.length) fail("as portas publicadas precisam ser distintas.");

  const passwords = PASSWORD_KEYS.map((k) => cfg[k]);
  for (const key of PASSWORD_KEYS) {
    if (cfg[key].length < 24) fail(`${key} é curta demais (mínimo 24 caracteres).`);
    if (!/^[A-Za-z0-9]+$/.test(cfg[key])) {
      fail(`${key} deve ser alfanumérica (use \`pnpm infra:env\` para gerar).`);
    }
  }
  if (new Set(passwords).size !== passwords.length) {
    fail("cada papel/ambiente precisa de uma senha diferente.");
  }

  if (!/^[a-z][a-z0-9_]*$/.test(cfg.DEV_DB_NAME) || !/^[a-z][a-z0-9_]*$/.test(cfg.TEST_DB_NAME)) {
    fail("nomes de banco devem usar apenas [a-z0-9_].");
  }
  if (!cfg.TEST_DB_NAME.endsWith("_test")) {
    fail("TEST_DB_NAME deve terminar em `_test` (proteção contra apontar o teste para dados reais).");
  }
  if (cfg.DEV_DB_NAME.endsWith("_test") || cfg.DEV_DB_NAME === cfg.TEST_DB_NAME) {
    fail("DEV_DB_NAME não pode ser o banco de testes.");
  }
  return cfg;
}

function assertLocalDocker() {
  const host = process.env.DOCKER_HOST;
  if (host && !host.startsWith("unix://")) {
    fail(`DOCKER_HOST aponta para um daemon não local (${host.split("://")[0]}://…). Recusado.`);
  }
}

// Ambiente do processo filho: remove tudo que poderia redirecionar o Compose
// ou o dbmate para outro lugar e fixa os valores vindos de .env.infra.
function childEnv(cfg) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(COMPOSE_|DBMATE_|PG)/.test(key) ||
      key === "DATABASE_URL" ||
      key in cfg
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...cfg };
}

// Ambiente de um processo Node filho (testes, verificação de schema): só o
// ambiente do shell SEM nada que redirecione conexões e SEM as variáveis de
// .env.infra — cada comando repassa explicitamente apenas o que precisa.
function nodeChildEnv(cfg, extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(COMPOSE_|DBMATE_|PG|APP_DATABASE_|AUTH_DATABASE_|DB_TEST_|AUTH_SCHEMA_|BETTER_AUTH_|AUTH_TRUSTED_|SMTP_|MAIL_)/.test(key) ||
      key === "DATABASE_URL" ||
      key in cfg
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...extra };
}

function testUrl(cfg, role, password) {
  return `postgres://${role}:${password}@127.0.0.1:${cfg.TEST_DB_PORT}/${cfg.TEST_DB_NAME}`;
}

// Identidade (Better Auth) LOCAL: banco do alvo como antero_auth, origem em
// localhost, segredo aleatório a cada execução (nunca gravado) e e-mails no
// Mailpit. Nenhuma credencial de outro ambiente.
function localIdentityEnv(cfg, target) {
  const prefix = target === "dev" ? "DEV" : "TEST";
  return {
    AUTH_DATABASE_URL: `postgres://antero_auth:${cfg[`${prefix}_AUTH_PASSWORD`]}@127.0.0.1:${cfg[`${prefix}_DB_PORT`]}/${cfg[`${prefix}_DB_NAME`]}`,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: cfg.MAILPIT_SMTP_PORT,
    SMTP_SECURE: "false",
    MAIL_FROM: "Antero Atendimento <nao-responda@antero.local>",
  };
}

function compose(cfg, args, { profiles = [], capture = false, input } = {}) {
  assertLocalDocker();
  const base = ["compose", "-p", PROJECT, "--file", COMPOSE_FILE, "--env-file", ENV_FILE];
  for (const profile of profiles) base.push("--profile", profile);
  const result = spawnSync("docker", [...base, ...args], {
    cwd: ROOT,
    env: childEnv(cfg),
    stdio: capture ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    input,
    encoding: "utf8",
  });
  if (result.error) fail(`não foi possível executar o docker: ${result.error.message}`);
  return result;
}

function run(cfg, args, options) {
  const result = compose(cfg, args, options);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function targetOf(value) {
  if (value !== "dev" && value !== "test") fail("informe o alvo: `dev` ou `test`.");
  return value;
}

function randomPassword() {
  return randomBytes(18).toString("hex"); // 36 caracteres hexadecimais
}

const commands = {
  // Cria .env.infra com senhas aleatórias. Nunca sobrescreve um arquivo
  // existente: se ele já existe, só acrescenta as senhas que faltarem (ex.:
  // DEV_AUTH_PASSWORD, introduzida na Entrega 2) e preserva todo o resto.
  env() {
    if (existsSync(ENV_FILE)) {
      const current = parseEnvFile(ENV_FILE);
      const missing = PASSWORD_KEYS.filter((key) => !current[key]);
      if (missing.length === 0) {
        console.log("[infra] .env.infra já existe — mantido sem alterações.");
        return;
      }
      let content = readFileSync(ENV_FILE, "utf8");
      for (const key of missing) {
        const line = `${key}=${randomPassword()}`;
        const empty = new RegExp(`^${key}=[ \\t]*$`, "m");
        content = empty.test(content)
          ? content.replace(empty, line)
          : `${content.replace(/\n?$/, "\n")}${line}\n`;
      }
      writeFileSync(ENV_FILE, content, { mode: 0o600 });
      chmodSync(ENV_FILE, 0o600);
      console.log(`[infra] .env.infra: senhas acrescentadas (${missing.join(", ")}); valores existentes preservados.`);
      return;
    }
    let content = readFileSync(ENV_EXAMPLE, "utf8");
    for (const key of PASSWORD_KEYS) {
      content = content.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${randomPassword()}`);
    }
    writeFileSync(ENV_FILE, content, { mode: 0o600 });
    chmodSync(ENV_FILE, 0o600);
    console.log("[infra] .env.infra criado (senhas aleatórias, permissão 600, ignorado pelo Git).");
  },

  up() {
    const cfg = loadConfig();
    run(cfg, ["up", "-d", "--wait", "postgres-dev", "mailpit"]);
  },

  stop() {
    const cfg = loadConfig();
    run(cfg, ["stop"], { profiles: ["test", "tools"] });
  },

  status() {
    const cfg = loadConfig();
    run(cfg, ["ps", "--all"], { profiles: ["test", "tools"] });
  },

  logs([service = "postgres-dev"]) {
    const cfg = loadConfig();
    if (!["postgres-dev", "postgres-test", "mailpit"].includes(service)) {
      fail("serviço inválido (postgres-dev, postgres-test ou mailpit).");
    }
    run(cfg, ["logs", "--tail", "100", service], { profiles: ["test"] });
  },

  "test-up"() {
    const cfg = loadConfig();
    run(cfg, ["up", "-d", "--wait", "postgres-test"], { profiles: ["test"] });
  },

  // Remove SÓ o container postgres-test deste projeto; os dados estão em tmpfs.
  "test-reset"() {
    const cfg = loadConfig();
    run(cfg, ["rm", "--force", "--stop", "--volumes", "postgres-test"], { profiles: ["test"] });
    run(cfg, ["up", "-d", "--wait", "postgres-test"], { profiles: ["test"] });
  },

  "test-stop"() {
    const cfg = loadConfig();
    run(cfg, ["rm", "--force", "--stop", "--volumes", "postgres-test"], { profiles: ["test"] });
  },

  migrate([target, command = "up"]) {
    targetOf(target);
    if (!MIGRATE_COMMANDS.has(command)) {
      fail(`comando de migration inválido. Use: ${[...MIGRATE_COMMANDS].join(", ")}.`);
    }
    const cfg = loadConfig();
    const service = target === "dev" ? "migrate-dev" : "migrate-test";
    run(cfg, ["run", "--rm", "--no-TTY", service, command], { profiles: ["tools", "test"] });
  },

  // Cria papéis novos e ressincroniza atributos/senhas num banco JÁ
  // inicializado, rodando o mesmo script idempotente do initdb. Não toca em
  // dados. O container precisa ter sido (re)criado com as variáveis atuais
  // (`pnpm infra:up` / `pnpm db:test:up` recriam quando o compose muda).
  roles([target]) {
    targetOf(target);
    const cfg = loadConfig();
    const service = target === "dev" ? "postgres-dev" : "postgres-test";
    const profiles = target === "test" ? ["test"] : [];
    run(cfg, ["exec", "-T", service, "bash", "/docker-entrypoint-initdb.d/10-roles.sh"], { profiles });
    console.log(`[infra] papéis sincronizados no banco ${target}.`);
  },

  // Confere, com o planejador de migrations do próprio Better Auth, que o
  // schema `auth` do alvo corresponde exatamente à configuração versionada
  // (src/lib/auth/better-auth-options.ts). Conecta como antero_auth — o mesmo
  // papel que o Better Auth usará — e NUNCA executa migrations.
  "auth-schema"([target, mode = "check"]) {
    targetOf(target);
    if (mode !== "check" && mode !== "print") fail("modo inválido: use `check` ou `print`.");
    const cfg = loadConfig();
    const prefix = target === "dev" ? "DEV" : "TEST";
    const port = cfg[`${prefix}_DB_PORT`];
    const db = cfg[`${prefix}_DB_NAME`];
    const result = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(ROOT, "scripts", "auth-schema.mjs"), mode], {
      cwd: ROOT,
      stdio: "inherit",
      env: nodeChildEnv(cfg, {
        AUTH_SCHEMA_DATABASE_URL: `postgres://antero_auth:${cfg[`${prefix}_AUTH_PASSWORD`]}@127.0.0.1:${port}/${db}?sslmode=disable`,
      }),
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  },

  // Provisiona uma identidade fictícia LOCAL (sem cadastro público): usa o
  // fluxo oficial do Better Auth numa instância privada, conectando como
  // antero_auth no banco do alvo. Repetível por e-mail. A senha gerada é
  // mostrada uma única vez e não é gravada. Ver docs/AUTH.md.
  //   pnpm auth:provision test --email a@exemplo.local --name "Nome" [--rotate-password]
  "auth-provision"([target, ...args]) {
    targetOf(target);
    const cfg = loadConfig();
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        join(ROOT, "scripts", "auth-provision.mjs"),
        ...args,
      ],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: nodeChildEnv(cfg, { NODE_ENV: "development", ...localIdentityEnv(cfg, target) }),
      },
    );
    if (result.error) fail(`não foi possível executar o provisionamento: ${result.error.message}`);
    if (result.status !== 0) process.exit(result.status ?? 1);
  },

  // Testes de integração da camada PostgreSQL (src/lib/db) e das consultas
  // SQL dos módulos (modules/*/sql-queries.ts) — SEMPRE contra o banco de
  // TESTES. O processo de teste recebe só as URLs desse banco (antero_app para
  // a camada; antero_migrator e antero_auth para fixtures) e ainda confirma no
  // servidor que é o banco descartável antes de escrever. O alias `@/` é
  // resolvido por tests/db/register-aliases.mjs.
  integration() {
    const cfg = loadConfig();
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--import=./tests/db/register-aliases.mjs",
        "--test",
        "--test-concurrency=1",
        "tests/db/*.test.ts",
      ],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: nodeChildEnv(cfg, {
          APP_DATABASE_URL: testUrl(cfg, "antero_app", cfg.TEST_APP_PASSWORD),
          DB_TEST_FIXTURE_URL: testUrl(cfg, "antero_migrator", cfg.TEST_MIGRATOR_PASSWORD),
          DB_TEST_AUTH_URL: testUrl(cfg, "antero_auth", cfg.TEST_AUTH_PASSWORD),
          DB_TEST_EXPECTED_DATABASE: cfg.TEST_DB_NAME,
          DB_TEST_EXPECTED_PORT: cfg.TEST_DB_PORT,
        }),
      },
    );
    if (result.error) fail(`não foi possível executar os testes: ${result.error.message}`);
    if (result.status !== 0) process.exit(result.status ?? 1);
  },

  // Cria um arquivo de migration vazio no formato do dbmate.
  new([name]) {
    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      fail("informe um nome em snake_case (a-z, 0-9, _). Ex.: pnpm db:new criar_tabela_x");
    }
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const file = join(ROOT, "db", "migrations", `${stamp}_${name}.sql`);
    if (existsSync(file)) fail("o arquivo já existe.");
    writeFileSync(file, "-- migrate:up\n\n\n-- migrate:down\n\n", { flag: "wx" });
    console.log(`[infra] criado ${file.replace(`${ROOT}/`, "")}`);
  },

  // Roda os testes pgTAP em db/tests dentro do container de TESTES.
  pgtap() {
    const cfg = loadConfig();
    // Superusuário do banco descartável: necessário para `SET ROLE antero_app`
    // nos testes de isolamento. Nunca usado contra o banco de desenvolvimento.
    run(
      cfg,
      ["exec", "-T", "postgres-test", "pg_prove", "-U", "antero_admin", "-d", cfg.TEST_DB_NAME, "--ext", ".sql", "--recurse", "--verbose", "/db/tests/"],
      { profiles: ["test"] },
    );
  },

  // Confere papéis e privilégios do alvo. Falha (exit 1) se algo estiver fora do desenhado.
  verify([target]) {
    targetOf(target);
    const cfg = loadConfig();
    const service = target === "dev" ? "postgres-dev" : "postgres-test";
    const dbName = target === "dev" ? cfg.DEV_DB_NAME : cfg.TEST_DB_NAME;
    const profiles = target === "test" ? ["test"] : [];

    const query = (sql, { user = "antero_admin", password } = {}) => {
      const args = ["exec", "-T"];
      if (password) args.push("-e", `PGPASSWORD=${password}`);
      args.push(service, "psql", "-X", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", dbName);
      if (password) args.push("-h", "127.0.0.1");
      args.push("-c", sql);
      const result = compose(cfg, args, { profiles, capture: true });
      return {
        ok: result.status === 0,
        out: (result.stdout ?? "").trim(),
        err: (result.stderr ?? "").trim().split("\n")[0],
      };
    };

    const prefix = target === "dev" ? "DEV" : "TEST";
    const appPassword = cfg[`${prefix}_APP_PASSWORD`];
    const migratorPassword = cfg[`${prefix}_MIGRATOR_PASSWORD`];
    const problems = [];
    const check = (label, condition, detail = "") => {
      console.log(`  ${condition ? "ok  " : "FALHA"} ${label}`);
      if (!condition) {
        if (detail) console.log(`        ${detail}`);
        problems.push(label);
      }
    };

    console.log(`[infra] verificando papéis do banco ${target} (${dbName})`);

    const roles = query(
      "select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin " +
        "from pg_roles where rolname in ('antero_owner','antero_migrator','antero_app','antero_auth') order by 1",
    );
    check(
      "papéis antero_owner, antero_migrator, antero_app e antero_auth existem",
      roles.ok && roles.out.split("\n").length === 4,
      "rode `pnpm db:roles` (dev) ou `pnpm db:test:roles` (teste)",
    );
    const flags = Object.fromEntries(roles.out.split("\n").filter(Boolean).map((l) => {
      const [name, ...rest] = l.split("|");
      return [name, rest];
    }));
    // ordem: super, bypassrls, createrole, createdb, replication, canlogin
    for (const role of ["antero_owner", "antero_migrator", "antero_app", "antero_auth"]) {
      const f = flags[role] ?? [];
      check(`${role}: sem superusuário/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION`, f.slice(0, 5).every((v) => v === "f") && f.length === 6);
    }
    check("antero_owner não faz login", (flags.antero_owner ?? [])[5] === "f");
    check(
      "antero_app, antero_auth e antero_migrator fazem login",
      ["antero_app", "antero_auth", "antero_migrator"].every((r) => (flags[r] ?? [])[5] === "t"),
    );

    const owners = query(
      `select (select pg_get_userbyid(datdba) from pg_database where datname = '${dbName}'), ` +
        "(select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'public')",
    );
    check("banco e schema public pertencem a antero_owner", owners.ok && owners.out === "antero_owner|antero_owner");

    const owned = query(
      "select count(*) from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname in ('antero_app','antero_auth')",
    );
    check("antero_app e antero_auth não possuem nenhum objeto", owned.ok && owned.out === "0");

    const privs = query(
      "select has_schema_privilege('antero_app','public','CREATE'), " +
        `has_database_privilege('antero_app','${dbName}','CREATE'), ` +
        `has_database_privilege('public','${dbName}','CONNECT'), ` +
        "has_schema_privilege('public','public','USAGE')",
    );
    check("antero_app não tem CREATE no schema nem no banco; PUBLIC sem CONNECT/USAGE", privs.ok && privs.out === "f|f|f|f");

    const authPrivs = query(
      "select has_schema_privilege('antero_auth','public','USAGE'), has_schema_privilege('antero_auth','public','CREATE'), " +
        `has_database_privilege('antero_auth','${dbName}','CREATE'), has_database_privilege('antero_auth','${dbName}','TEMP')`,
    );
    check("antero_auth sem USAGE/CREATE em public e sem CREATE/TEMP no banco", authPrivs.ok && authPrivs.out === "f|f|f|f");

    const app = query("select current_user, session_user, current_setting('is_superuser')", {
      user: "antero_app",
      password: appPassword,
    });
    check("antero_app conecta por TCP e não é superusuário", app.ok && app.out === "antero_app|antero_app|off", app.err);

    const create = query("create table public.__antero_probe (id int)", { user: "antero_app", password: appPassword });
    check(
      "antero_app NÃO consegue criar objetos (permission denied)",
      !create.ok && /permission denied/.test(create.err),
      create.err,
    );

    const authLogin = query("select current_user, session_user, current_setting('is_superuser')", {
      user: "antero_auth",
      password: cfg[`${prefix}_AUTH_PASSWORD`],
    });
    check("antero_auth conecta por TCP e não é superusuário", authLogin.ok && authLogin.out === "antero_auth|antero_auth|off", authLogin.err);

    // Depois da migration 0000: separação entre identidade e aplicação.
    const authSchema = query("select count(*) from pg_namespace where nspname = 'auth'");
    if (authSchema.ok && authSchema.out === "1") {
      const sep = query(
        "select has_schema_privilege('antero_app','auth','USAGE'), has_schema_privilege('antero_auth','auth','USAGE'), " +
          "has_schema_privilege('antero_auth','auth','CREATE'), pg_get_userbyid(nspowner) from pg_namespace where nspname = 'auth'",
      );
      check(
        "schema auth: dono antero_owner; antero_auth com USAGE (sem CREATE); antero_app sem acesso",
        sep.ok && sep.out === "f|t|f|antero_owner",
        sep.out,
      );
      const leak = query("select count(*) from auth.accounts", { user: "antero_app", password: appPassword });
      check(
        "antero_app NÃO lê auth.accounts (hashes de senha)",
        !leak.ok && /permission denied/.test(leak.err),
        leak.err || leak.out,
      );
    } else {
      console.log("  --   schema auth ainda não existe (migrations pendentes)");
    }

    const migrator = query("select current_user, session_user, current_setting('is_superuser')", {
      user: "antero_migrator",
      password: migratorPassword,
    });
    check("antero_migrator conecta e opera como antero_owner (não superusuário)", migrator.ok && migrator.out === "antero_owner|antero_migrator|off", migrator.err);

    const pgtap = query("select count(*) from pg_extension where extname = 'pgtap'");
    check(
      target === "test" ? "pgTAP instalado (banco de testes)" : "pgTAP ausente (banco de desenvolvimento)",
      pgtap.ok && pgtap.out === (target === "test" ? "1" : "0"),
    );

    if (problems.length > 0) fail(`${problems.length} verificação(ões) falharam.`);
    console.log("[infra] todas as verificações passaram.");
  },
};

const [name, ...rest] = process.argv.slice(2);
if (!name || !(name in commands)) {
  console.error(`Uso: node scripts/infra.mjs <${Object.keys(commands).join("|")}> [args]`);
  process.exit(2);
}
commands[name](rest);
