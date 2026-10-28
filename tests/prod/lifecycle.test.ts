/**
 * Entrega 7A — ciclo de vida da imagem de produção (`pnpm homolog:prod
 * lifecycle`): indisponibilidade temporária do PostgreSQL, SIGTERM/SIGINT,
 * drenagem de requisição em andamento, fechamento dos pools e reinício.
 *
 * Só toca nos contêineres da homologação (`antero-atendimentos-homolog-*`);
 * qualquer outro nome é recusado.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { after, before, test } from "node:test";

import pg from "pg";

const HTTPS = process.env.HOMOLOG_HTTPS_URL as string;
const DIRECT = process.env.HOMOLOG_DIRECT_URL as string;
const ADMIN_URL = process.env.HOMOLOG_ADMIN_URL as string;
const APP = "antero-atendimentos-homolog-app";
const APP_E2E = "antero-atendimentos-homolog-app-e2e";
const DB = "antero-atendimentos-homolog-db";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function docker(args: string[]): string {
  const target = args.find((arg) => arg.startsWith("antero-atendimentos-"));
  assert.ok(!target || target.startsWith("antero-atendimentos-homolog-"), `contêiner fora da homologação: ${target}`);
  const result = spawnSync("docker", args, { encoding: "utf8" });
  assert.equal(result.status, 0, `docker ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
const inspect = (container: string, format: string) => docker(["inspect", "--format", format, container]);

async function status(path: string, base = HTTPS): Promise<number> {
  try {
    return (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })).status;
  } catch {
    return 0;
  }
}

async function until(label: string, check: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  assert.fail(`tempo esgotado: ${label}`);
}

let admin: pg.Client;
const connect = async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
};
/** Conexões abertas por um contêiner (IP) no banco, pelos dois papéis da aplicação. */
const ips = new Map<string, string[]>();
async function connectionsOf(container: string): Promise<number> {
  // O IP só existe com o contêiner de pé: guarda o último conhecido.
  const current = inspect(container, "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}").split(" ").filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (current.length) ips.set(container, current);
  const ip = ips.get(container) ?? [];
  const { rows } = await admin.query(
    "select count(*)::int as n from pg_stat_activity where client_addr = any($1::inet[]) and application_name like 'antero-atendimentos%'",
    [ip],
  );
  return rows[0].n;
}
/** Logs do contêiner desde `since` (logs persistem entre reinícios do mesmo contêiner). */
const logsOf = (container: string, since?: string) => {
  const result = spawnSync("docker", ["logs", ...(since ? ["--since", since] : []), container], { encoding: "utf8" });
  return `${result.stdout}${result.stderr}`;
};

before(async () => {
  assert.ok(HTTPS && DIRECT && ADMIN_URL, "use `pnpm homolog:prod lifecycle`");
  await connect();
  await until("app pronta", async () => (await status("/api/health/ready")) === 200);
});

after(async () => {
  await admin?.end().catch(() => {});
  for (const container of [DB, APP, APP_E2E]) {
    if (inspect(container, "{{.State.Running}}") !== "true") docker(["start", container]);
  }
});

test("PostgreSQL indisponível: prontidão 503, liveness 200, erros neutros; volta sozinho, sem reiniciar a aplicação nem perder dados", async () => {
  const startedAt = inspect(APP, "{{.State.StartedAt}}");
  const slug = `homolog-lifecycle-${Date.now()}`;
  await admin.query("insert into public.organizations (name, slug) values ('Lifecycle Fictícia', $1)", [slug]);
  assert.ok((await connectionsOf(APP)) > 0, "a aplicação mantém conexões abertas");
  await admin.end();

  docker(["stop", "--time", "20", DB]);
  await until("prontidão 503", async () => (await status("/api/health/ready")) === 503, 20_000);
  assert.equal(await status("/api/health"), 200, "processo vivo");
  assert.equal(await status("/login"), 200, "tela pública segue servida");
  const login = await fetch(`${HTTPS}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: HTTPS },
    body: JSON.stringify({ email: "ninguem@teste.local", password: "senha-qualquer-123" }),
  });
  assert.equal(login.status, 503);
  const body = await login.text();
  assert.doesNotMatch(body, /postgres|ECONN|5432|antero_|password authentication/i, "erro neutro");
  assert.equal((await fetch(`${HTTPS}/api/health/ready`)).headers.get("set-cookie"), null);

  docker(["start", DB]);
  await until("db saudável", async () => inspect(DB, "{{.State.Health.Status}}") === "healthy");
  await until("prontidão 200 sem reiniciar a aplicação", async () => (await status("/api/health/ready")) === 200, 30_000);
  assert.equal(inspect(APP, "{{.State.StartedAt}}"), startedAt, "mesmo processo");
  assert.equal(inspect(APP, "{{.RestartCount}}"), "0");

  await connect();
  const { rows } = await admin.query("select slug from public.organizations where slug = $1", [slug]);
  assert.equal(rows.length, 1, "dados preservados após a queda");
  await admin.query("delete from public.organizations where slug = $1", [slug]);
  assert.ok((await connectionsOf(APP)) <= 15, "sem acúmulo de conexões após a recuperação");
});

test("SIGTERM (docker stop): código 143, pools fechados, nenhuma conexão abandonada; reinicia e volta a atender", async () => {
  assert.ok((await connectionsOf(APP)) > 0);
  const mark = new Date().toISOString();
  const began = Date.now();
  docker(["stop", "--time", "30", APP]);
  assert.ok(Date.now() - began < 15_000, "encerrou bem antes do SIGKILL");
  assert.equal(inspect(APP, "{{.State.ExitCode}}"), "143");
  assert.equal(inspect(APP, "{{.State.OOMKilled}}"), "false");
  const logs = logsOf(APP, mark);
  assert.match(logs, /\[shutdown\] SIGTERM recebido/);
  assert.match(logs, /\[shutdown\] conexões do PostgreSQL encerradas/);
  assert.equal(await connectionsOf(APP), 0, "nenhuma conexão restante no PostgreSQL");

  docker(["start", APP]);
  await until("app saudável de novo", async () => inspect(APP, "{{.State.Health.Status}}") === "healthy");
  await until("proxy volta a rotear", async () => (await status("/api/health/ready")) === 200, 30_000);
});

test("SIGINT: código 130 e pools fechados", async () => {
  const mark = new Date().toISOString();
  docker(["kill", "--signal=SIGINT", APP]);
  await until("encerrou", async () => inspect(APP, "{{.State.Running}}") === "false", 20_000);
  assert.equal(inspect(APP, "{{.State.ExitCode}}"), "130");
  assert.match(logsOf(APP, mark), /\[shutdown\] SIGINT recebido/);
  assert.equal(await connectionsOf(APP), 0);
  docker(["start", APP]);
  await until("app saudável", async () => inspect(APP, "{{.State.Health.Status}}") === "healthy");
});

test("requisição em andamento é concluída antes de a aplicação sair; só depois os pools fecham", async () => {
  const url = new URL(DIRECT);
  const payload = JSON.stringify({ email: "ninguem@teste.local", password: "senha-qualquer-123" });
  const half = Math.floor(payload.length / 2);
  const mark = new Date().toISOString();

  const response = new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: "/api/auth/sign-in/email",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          origin: HTTPS,
          "x-forwarded-for": "203.0.113.77",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.write(payload.slice(0, half));
    // Corpo incompleto = requisição em andamento durante o SIGTERM.
    setTimeout(() => {
      assert.equal(inspect(APP_E2E, "{{.State.Running}}"), "true");
      const stop = spawn("docker", ["stop", "--time", "30", APP_E2E], { stdio: "ignore" });
      setTimeout(() => {
        // 1,5 s depois do SIGTERM o processo continua de pé, esperando a requisição.
        try {
          assert.equal(inspect(APP_E2E, "{{.State.Running}}"), "true", "drenando, não encerrou");
          assert.match(logsOf(APP_E2E, mark), /\[shutdown\] SIGTERM recebido/);
          assert.doesNotMatch(logsOf(APP_E2E, mark), /conexões do PostgreSQL encerradas/);
          request.end(payload.slice(half));
        } catch (error) {
          reject(error);
        }
      }, 1500);
      stop.on("error", reject);
    }, 300);
  });

  const code = await response;
  assert.ok([200, 401].includes(code), `a requisição em andamento recebeu resposta (HTTP ${code})`);
  await until("encerrou depois do drain", async () => inspect(APP_E2E, "{{.State.Running}}") === "false", 30_000);
  assert.equal(inspect(APP_E2E, "{{.State.ExitCode}}"), "143");
  assert.match(logsOf(APP_E2E, mark), /conexões do PostgreSQL encerradas/);
  assert.equal(await connectionsOf(APP_E2E), 0);
  docker(["start", APP_E2E]);
  await until("app-e2e saudável", async () => inspect(APP_E2E, "{{.State.Health.Status}}") === "healthy");
});
