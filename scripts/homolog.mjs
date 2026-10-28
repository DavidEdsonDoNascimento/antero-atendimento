#!/usr/bin/env node
// Homologação LOCAL da imagem de produção (Entrega 7A). Ver docs/DEPLOY.md.
//
// Sobe a stack de `compose.homolog.yaml` (projeto `antero-atendimentos-homolog`):
// PostgreSQL descartável, Mailpit, Traefik com TLS e a imagem de produção. Os
// segredos (senhas, segredo do Better Auth) e o certificado autoassinado são
// gerados na hora em ~/.cache/antero-atendimentos/homolog/ (FORA do
// repositório, permissão 600) — nunca vêm de .env.local/.env.infra e nunca são
// impressos. Só dados fictícios; nenhum serviço remoto.
//
// Proteções: projeto e arquivo Compose sempre fixos; recusa DOCKER_HOST não
// local; descarta variáveis do shell que redirecionariam o Compose; o único
// comando destrutivo (`reset`) remove SÓ o volume da própria homologação.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "antero-atendimentos-homolog";
const COMPOSE_FILE = join(ROOT, "compose.homolog.yaml");
const HOMOLOG_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "antero-atendimentos", "homolog");
const ENV_FILE = join(HOMOLOG_DIR, "homolog.env");
const TLS_DIR = join(HOMOLOG_DIR, "tls");
const VOLUME = "antero-atendimentos-homolog-pgdata";

const PORTS = {
  HOMOLOG_DB_PORT: "55436",
  HOMOLOG_MAILPIT_PORT: "55437",
  HOMOLOG_HTTPS_PORT: "8443",
  HOMOLOG_E2E_PORT: "3471",
};
const CONTAINERS = {
  app: "antero-atendimentos-homolog-app",
  appE2e: "antero-atendimentos-homolog-app-e2e",
  db: "antero-atendimentos-homolog-db",
};

function fail(message) {
  console.error(`[homolog] ERRO: ${message}`);
  process.exit(1);
}

function parseEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

function assertLocalDocker() {
  const host = process.env.DOCKER_HOST;
  if (host && !host.startsWith("unix://")) fail(`DOCKER_HOST não local (${host.split("://")[0]}://…). Recusado.`);
}

function ensureSecrets() {
  mkdirSync(TLS_DIR, { recursive: true, mode: 0o755 });
  chmodSync(HOMOLOG_DIR, 0o755);
  if (!existsSync(join(TLS_DIR, "cert.pem"))) {
    // Certificado autoassinado de homologação (30 dias), só para localhost.
    // Os contêineres (Traefik, Mailpit) rodam com outro usuário: arquivos 644.
    const result = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
        "-keyout", join(TLS_DIR, "key.pem"), "-out", join(TLS_DIR, "cert.pem"),
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,DNS:mailpit,IP:127.0.0.1",
      ],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    if (result.status !== 0) fail(`openssl falhou: ${result.stderr?.split("\n")[0] ?? result.error?.message}`);
    chmodSync(join(TLS_DIR, "key.pem"), 0o644);
    chmodSync(join(TLS_DIR, "cert.pem"), 0o644);
    console.log("[homolog] certificado autoassinado de homologação criado (fora do repositório).");
  }
  if (existsSync(ENV_FILE)) return;
  const password = () => randomBytes(18).toString("hex");
  const values = {
    HOMOLOG_DIR,
    HOMOLOG_DB_NAME: "antero_atendimentos_homolog_test",
    HOMOLOG_ADMIN_PASSWORD: password(),
    HOMOLOG_MIGRATOR_PASSWORD: password(),
    HOMOLOG_APP_PASSWORD: password(),
    HOMOLOG_AUTH_PASSWORD: password(),
    HOMOLOG_AUTH_SECRET: randomBytes(32).toString("base64url"),
    ...PORTS,
  };
  const lines = [
    "# Segredos EFÊMEROS da homologação local (gerados por scripts/homolog.mjs). Não versionar.",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ];
  writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  console.log("[homolog] segredos efêmeros gerados (permissão 600, fora do repositório).");
}

function loadConfig() {
  ensureSecrets();
  return parseEnvFile(ENV_FILE);
}

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(COMPOSE_|DBMATE_|PG|APP_DATABASE_|AUTH_DATABASE_|DB_TEST_|BETTER_AUTH_|AUTH_TRUSTED_|SMTP_|MAIL_|NEXT_|E2E_|HOMOLOG_)/.test(key)) continue;
    if (key === "DATABASE_URL" || key === "NODE_OPTIONS" || key === "NODE_ENV") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function compose(args, { capture = false, input } = {}) {
  assertLocalDocker();
  loadConfig();
  const result = spawnSync(
    "docker",
    ["compose", "-p", PROJECT, "--file", COMPOSE_FILE, "--env-file", ENV_FILE, "--profile", "tools", "--profile", "e2e", ...args],
    { cwd: ROOT, env: cleanEnv(), stdio: capture ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"], input, encoding: "utf8" },
  );
  if (result.error) fail(`não foi possível executar o docker: ${result.error.message}`);
  return result;
}

function run(args) {
  const result = compose(args);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Ambiente dos testes que rodam NO HOST contra a homologação (NODE_ENV=test). */
function testEnv(cfg) {
  const url = (role, password) => `postgres://${role}:${password}@127.0.0.1:${cfg.HOMOLOG_DB_PORT}/${cfg.HOMOLOG_DB_NAME}`;
  return cleanEnv({
    NODE_ENV: "test",
    NODE_EXTRA_CA_CERTS: join(TLS_DIR, "cert.pem"),
    // Mesmo segredo/origem do servidor: os testes leem a sessão como o DAL.
    BETTER_AUTH_URL: `https://localhost:${cfg.HOMOLOG_HTTPS_PORT}`,
    BETTER_AUTH_SECRET: cfg.HOMOLOG_AUTH_SECRET,
    AUTH_DATABASE_URL: url("antero_auth", cfg.HOMOLOG_AUTH_PASSWORD),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1025",
    SMTP_SECURE: "false",
    MAIL_FROM: "Antero Atendimento <nao-responda@antero.local>",
    DB_TEST_MAILPIT_URL: `http://127.0.0.1:${cfg.HOMOLOG_MAILPIT_PORT}`,
    APP_DATABASE_URL: url("antero_app", cfg.HOMOLOG_APP_PASSWORD),
    DB_TEST_FIXTURE_URL: url("antero_migrator", cfg.HOMOLOG_MIGRATOR_PASSWORD),
    DB_TEST_AUTH_URL: url("antero_auth", cfg.HOMOLOG_AUTH_PASSWORD),
    DB_TEST_EXPECTED_DATABASE: cfg.HOMOLOG_DB_NAME,
    DB_TEST_EXPECTED_PORT: cfg.HOMOLOG_DB_PORT,
    HOMOLOG_PROJECT: PROJECT,
    HOMOLOG_HTTPS_URL: `https://localhost:${cfg.HOMOLOG_HTTPS_PORT}`,
    HOMOLOG_DIRECT_URL: `http://127.0.0.1:${cfg.HOMOLOG_E2E_PORT}`,
    HOMOLOG_ADMIN_URL: `postgres://antero_admin:${cfg.HOMOLOG_ADMIN_PASSWORD}@127.0.0.1:${cfg.HOMOLOG_DB_PORT}/${cfg.HOMOLOG_DB_NAME}`,
    HOMOLOG_CA_FILE: join(TLS_DIR, "cert.pem"),
  });
}

function runTests(cfg, files, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import=./tests/db/register-aliases.mjs",
      "--test",
      "--test-concurrency=1",
      ...files,
    ],
    { cwd: ROOT, stdio: "inherit", env: { ...testEnv(cfg), ...extraEnv } },
  );
  if (result.error) fail(`não foi possível executar os testes: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function waitHealthy(container, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = spawnSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", container], { encoding: "utf8" });
    if (out.stdout.trim() === "healthy") return;
    await new Promise((done) => setTimeout(done, 1000));
  }
  fail(`${container} não ficou saudável a tempo.`);
}

const commands = {
  env() {
    loadConfig();
    console.log(`[homolog] segredos e certificado em ${HOMOLOG_DIR.replace(homedir(), "~")}`);
  },

  // Constrói a imagem de produção (alvo runtime) e a de migrations (alvo migrate).
  build() {
    run(["build", "app", "migrate"]);
  },

  // Sequência de um deploy: banco + e-mail → migrations (passo separado e
  // explícito) → aplicação + proxy. A aplicação NUNCA migra sozinha.
  up() {
    run(["up", "-d", "--wait", "db", "mailpit"]);
    run(["run", "--rm", "--no-TTY", "migrate", "up"]);
    run(["up", "-d", "--wait", "app", "traefik"]);
    const cfg = loadConfig();
    console.log(`[homolog] pronto: https://localhost:${cfg.HOMOLOG_HTTPS_PORT} (certificado autoassinado), Mailpit http://127.0.0.1:${cfg.HOMOLOG_MAILPIT_PORT}`);
  },

  migrate([command = "up"]) {
    if (!["up", "status"].includes(command)) fail("use `up` ou `status`.");
    run(["run", "--rm", "--no-TTY", "migrate", command]);
  },

  status() {
    run(["ps", "--all"]);
  },

  logs([service = "app"]) {
    if (!["app", "app-e2e", "db", "mailpit", "traefik"].includes(service)) fail("serviço inválido.");
    run(["logs", "--tail", "200", service]);
  },

  // Para e remove os contêineres e redes da homologação. Mantém o volume.
  down() {
    run(["down", "--remove-orphans"]);
  },

  // Remove contêineres, redes e o VOLUME da homologação (dados fictícios) e os
  // segredos efêmeros. Só o que este script criou; nada do desenvolvimento.
  reset() {
    run(["down", "--remove-orphans"]);
    spawnSync("docker", ["volume", "rm", VOLUME], { stdio: "inherit" });
    rmSync(ENV_FILE, { force: true });
    console.log("[homolog] homologação removida (contêineres, redes, volume e segredos).");
  },

  // Verificação do CONTEÚDO da imagem de produção (usuário, ambiente, arquivos,
  // dependências e ausência de segredos). Reprodutível; nunca imprime valores.
  async "image-check"() {
    assertLocalDocker();
    const image = "antero-atendimentos/app:homolog";
    const problems = [];
    const check = (label, ok, detail = "") => {
      console.log(`  ${ok ? "ok   " : "FALHA"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
      if (!ok) problems.push(label);
    };
    const sh = (args, options = {}) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 30, ...options });
    const info = JSON.parse(sh(["image", "inspect", image]).stdout)[0];
    const cfg = info.Config;
    console.log(`[homolog] imagem ${image}: ${(info.Size / 1e6).toFixed(0)} MB de conteúdo comprimido (docker images mostra o tamanho em disco)`);
    check("executa como usuário não root", cfg.User === "node");
    check("NODE_ENV=production, PORT=3000, HOSTNAME=0.0.0.0", ["NODE_ENV=production", "PORT=3000", "HOSTNAME=0.0.0.0"].every((e) => cfg.Env.includes(e)));
    check("CMD em forma exec (Node é o PID 1)", JSON.stringify(cfg.Cmd) === '["node","server.js"]');
    check("HEALTHCHECK de prontidão definido", JSON.stringify(cfg.Healthcheck?.Test) === '["CMD","node","healthcheck.mjs"]');
    const secretKey = /(PASSWORD|SECRET|TOKEN|DATABASE_URL|SMTP_|BETTER_AUTH|KEY)/i;
    check("nenhuma variável sensível no ambiente da imagem", !cfg.Env.some((e) => secretKey.test(e.split("=")[0])));
    const history = sh(["history", "--no-trunc", "--format", "{{.CreatedBy}}", image]).stdout;
    check("histórico sem ARG/ENV sensível", !/(PASSWORD|SECRET|TOKEN|DATABASE_URL|BETTER_AUTH)/i.test(history));

    const probe = sh(["run", "--rm", "--entrypoint", "sh", image, "-c", [
      "id -u",
      "find / -xdev \\( -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.sql' -o -name '*.test.*' -o -name '*.bak' -o -name '*.dump' \\) -not -path '/usr/*' -not -path '/opt/*' 2>/dev/null | head -5",
      "echo '--'",
      "for p in typescript eslint tailwindcss @types/node babel-plugin-react-compiler; do [ -e /app/node_modules/$p ] && echo \"dep:$p\"; done",
      "command -v pnpm || true",
      "touch /app/x 2>/dev/null && echo escrita-em-app",
    ].join("; ")]).stdout.split("\n");
    const [uid, ...rest] = probe;
    const split = rest.indexOf("--");
    check("uid do processo ≠ 0", uid.trim() !== "0");
    check("sem .env, chaves, dumps, SQL ou testes na imagem", split === 0, rest.slice(0, split).join(", "));
    const after = rest.slice(split + 1).filter(Boolean);
    check("sem devDependencies (typescript, eslint, tailwind...) no runtime", !after.some((l) => l.startsWith("dep:")), after.join(","));
    check("sem pnpm no runtime", !after.some((l) => l.includes("pnpm")));
    check("/app somente leitura para o usuário da aplicação", !after.includes("escrita-em-app"));

    // Nenhum valor real dos arquivos de ambiente locais pode aparecer no sistema de arquivos da imagem.
    const secrets = new Set();
    for (const file of [".env.local", ".env.infra", ENV_FILE]) {
      const path = file.startsWith("/") ? file : join(ROOT, file);
      if (!existsSync(path)) continue;
      for (const value of Object.values(parseEnvFile(path))) if (value.length >= 12) secrets.add(value);
    }
    const container = sh(["create", image]).stdout.trim();
    try {
      const exported = spawnSync("docker", ["export", container], { maxBuffer: 1 << 30 });
      const tar = exported.stdout;
      check("(sanidade) a busca encontra um texto que está na imagem", tar.includes(Buffer.from("/api/health/ready")));
      const leaked = [...secrets].filter((value) => tar.includes(Buffer.from(value)));
      check(`nenhum dos ${secrets.size} valores de .env.local/.env.infra/homologação aparece na imagem`, leaked.length === 0, `${leaked.length} valor(es) encontrados`);
    } finally {
      sh(["rm", container]);
    }
    if (problems.length) fail(`${problems.length} verificação(ões) falharam.`);
    console.log("[homolog] imagem aprovada.");
  },

  // Suíte E2E existente (tests/e2e) contra a imagem de PRODUÇÃO (app-e2e).
  async e2e() {
    const cfg = loadConfig();
    run(["up", "-d", "--wait", "db", "mailpit"]);
    run(["run", "--rm", "--no-TTY", "migrate", "up"]);
    run(["up", "-d", "app-e2e"]);
    await waitHealthy(CONTAINERS.appE2e);
    runTests(cfg, ["tests/e2e/*.test.ts"], {
      E2E_BASE_URL: `http://127.0.0.1:${cfg.HOMOLOG_E2E_PORT}`,
      E2E_ORIGIN: `https://localhost:${cfg.HOMOLOG_HTTPS_PORT}`,
    });
  },

  // Proxy/TLS/cookies/X-Forwarded-For e ciclo de vida (tests/prod).
  async prod([which = "*"]) {
    if (!/^[a-z-*]+$/.test(which)) fail("filtro inválido.");
    const cfg = loadConfig();
    run(["up", "-d", "--wait", "db", "mailpit"]);
    run(["run", "--rm", "--no-TTY", "migrate", "up"]);
    run(["up", "-d", "--wait", "app", "traefik", "app-e2e"]);
    // Os limites de tentativas ficam na memória do processo: reiniciar as duas
    // instâncias começa cada execução com contadores zerados.
    for (const container of [CONTAINERS.app, CONTAINERS.appE2e]) {
      spawnSync("docker", ["restart", "--time", "30", container], { stdio: "ignore" });
    }
    await waitHealthy(CONTAINERS.app);
    await waitHealthy(CONTAINERS.appE2e);
    runTests(cfg, [`tests/prod/${which}.test.ts`]);
  },
};

const [name, ...rest] = process.argv.slice(2);
if (!name || !(name in commands)) {
  console.error(`Uso: node scripts/homolog.mjs <${Object.keys(commands).join("|")}> [args]`);
  process.exit(2);
}
await commands[name](rest);
