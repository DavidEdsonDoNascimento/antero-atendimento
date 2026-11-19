/**
 * E2B-1 — `scripts/whatsapp-channel.mjs` executado de verdade contra o banco de
 * TESTES (antero_migrator, a mesma conexão das fixtures). Ids da Meta
 * fictícios. Rode com `pnpm db:test:integration whatsapp-channel`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { connectFixtureClient, uniqueMetaId } from "./harness.ts";

const suffix = randomBytes(5).toString("hex");
let fixture: pg.Client;
const org = { a: "", b: "", suspended: "" };

/** Ambiente mínimo do script: só o que ele lê (e o PATH). */
const scriptEnv = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, NODE_ENV: "test", ...extra });

function channelScript(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/whatsapp-channel.mjs", ...args],
    {
      encoding: "utf8",
      env: scriptEnv({
        WHATSAPP_CHANNEL_DATABASE_URL: process.env.DB_TEST_FIXTURE_URL,
        WHATSAPP_CHANNEL_EXPECTED_DATABASE: process.env.DB_TEST_EXPECTED_DATABASE,
      }),
    },
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

async function channelsOf(phone: string) {
  const { rows } = await fixture.query<{ organization_id: string; external_business_account_id: string; status: string; display_name: string | null }>(
    "SELECT organization_id, external_business_account_id, status, display_name FROM public.whatsapp_accounts WHERE external_account_id = $1",
    [phone],
  );
  return rows;
}

before(async () => {
  fixture = await connectFixtureClient();
  const { rows } = await fixture.query<{ id: string; slug: string }>(
    `INSERT INTO public.organizations (name, slug, status) VALUES
       ($1, $2, 'active'), ($3, $4, 'active'), ($5, $6, 'inactive')
     RETURNING id, slug`,
    [`Canal A ${suffix}`, `canal-a-${suffix}`, `Canal B ${suffix}`, `canal-b-${suffix}`, `Canal S ${suffix}`, `canal-s-${suffix}`],
  );
  org.a = rows.find((row) => row.slug.startsWith("canal-a"))!.id;
  org.b = rows.find((row) => row.slug.startsWith("canal-b"))!.id;
  org.suspended = rows.find((row) => row.slug.startsWith("canal-s"))!.id;
});

after(async () => {
  await fixture.query("DELETE FROM public.organizations WHERE id = ANY($1::uuid[])", [[org.a, org.b, org.suspended]]);
  await fixture.end();
});

test("sem --apply só simula: nada gravado", async () => {
  const phone = uniqueMetaId();
  const run = channelScript("--organization", org.a, "--phone-number-id", phone, "--waba-id", uniqueMetaId());
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /SIMULAÇÃO: canal cloud_api criado/);
  assert.deepEqual(await channelsOf(phone), []);
});

test("--apply grava desconectado por padrão; repetir não muda nada; só o status pode mudar", async () => {
  const phone = uniqueMetaId();
  const waba = uniqueMetaId();
  const base = ["--organization", org.a, "--phone-number-id", phone, "--waba-id", waba, "--display-name", `Atendimento ${suffix}`];
  const created = channelScript(...base, "--apply");
  assert.equal(created.status, 0, created.out);
  assert.match(created.out, /GRAVADO: canal cloud_api criado .*status disconnected/);
  assert.deepEqual(await channelsOf(phone), [{ organization_id: org.a, external_business_account_id: waba, status: "disconnected", display_name: `Atendimento ${suffix}` }]);

  const again = channelScript(...base, "--apply");
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /nada a fazer/);

  const connected = channelScript(...base, "--status", "connected", "--apply");
  assert.equal(connected.status, 0, connected.out);
  assert.match(connected.out, /status disconnected → connected/);
  assert.equal((await channelsOf(phone))[0].status, "connected");
});

test("recusas: número de outra organização, WABA de outra organização, outra WABA no mesmo número, organização suspensa ou inexistente", async () => {
  const phone = uniqueMetaId();
  const waba = uniqueMetaId();
  assert.equal(channelScript("--organization", org.a, "--phone-number-id", phone, "--waba-id", waba, "--apply").status, 0);

  const cases: [string[], RegExp][] = [
    [["--organization", org.b, "--phone-number-id", phone, "--waba-id", uniqueMetaId()], /OUTRA organização/],
    [["--organization", org.b, "--phone-number-id", uniqueMetaId(), "--waba-id", waba], /WABA já está vinculada a OUTRA organização/],
    [["--organization", org.a, "--phone-number-id", phone, "--waba-id", uniqueMetaId()], /com outra WABA/],
    [["--organization", org.suspended, "--phone-number-id", uniqueMetaId(), "--waba-id", uniqueMetaId()], /suspensa/],
    [["--organization", randomUUID(), "--phone-number-id", uniqueMetaId(), "--waba-id", uniqueMetaId()], /não encontrada/],
  ];
  for (const [args, message] of cases) {
    const run = channelScript(...args, "--apply");
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, message);
  }
  assert.deepEqual(await channelsOf(phone), [{ organization_id: org.a, external_business_account_id: waba, status: "disconnected", display_name: null }]);
  const { rows } = await fixture.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.whatsapp_accounts WHERE organization_id = ANY($1::uuid[])",
    [[org.b, org.suspended]],
  );
  assert.equal(rows[0].n, 0, "nenhum canal criado nas outras organizações");
});

test("entrada inválida e conexão errada: recusa sem tocar no banco e sem imprimir a conexão", async () => {
  for (const args of [
    ["--organization", "nao-e-uuid", "--phone-number-id", uniqueMetaId(), "--waba-id", uniqueMetaId()],
    ["--organization", org.a, "--phone-number-id", "abc", "--waba-id", uniqueMetaId()],
    ["--organization", org.a, "--phone-number-id", uniqueMetaId(), "--waba-id", uniqueMetaId(), "--status", "ligado"],
    ["--organization", org.a, "--desconhecido", "x"],
  ]) {
    const run = channelScript(...args);
    assert.equal(run.status, 1, run.out);
  }
  const asApp = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/whatsapp-channel.mjs",
    "--organization", org.a, "--phone-number-id", uniqueMetaId(), "--waba-id", uniqueMetaId()], {
    encoding: "utf8",
    env: scriptEnv({ WHATSAPP_CHANNEL_DATABASE_URL: process.env.APP_DATABASE_URL }),
  });
  assert.equal(asApp.status, 1);
  assert.match(asApp.stderr, /papel antero_migrator/);
  const password = decodeURIComponent(new URL(process.env.DB_TEST_FIXTURE_URL!).password);
  const wrongDb = new URL(process.env.DB_TEST_FIXTURE_URL!);
  const run = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/whatsapp-channel.mjs",
    "--organization", org.a, "--phone-number-id", uniqueMetaId(), "--waba-id", uniqueMetaId()], {
    encoding: "utf8",
    env: scriptEnv({ WHATSAPP_CHANNEL_DATABASE_URL: wrongDb.toString(), WHATSAPP_CHANNEL_EXPECTED_DATABASE: "outro_banco" }),
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /não é o alvo esperado/);
  assert.ok(!`${run.stdout}${run.stderr}${asApp.stderr}`.includes(password), "a senha nunca aparece na saída");
});
