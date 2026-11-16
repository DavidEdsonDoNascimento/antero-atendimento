/**
 * G2B — auditoria administrativa pela camada da aplicação (pool `antero_app`,
 * sem BYPASSRLS): os eventos nascem na mesma transação das operações do admin
 * da plataforma, com autor e organização certos, inclusive sob concorrência
 * real. O dono das tabelas só monta cenários e confere o banco.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { closeAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import { setOrganizationModule, setOrganizationStatus } from "../../src/modules/organizations/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "./inbox-fixtures.ts";

let fixture: pg.Client;
let f: InboxFixtures;

type Event = { action: string; actor_kind: string; actor_user_id: string | null; details: Record<string, unknown> };

async function eventsOf(organizationId: string): Promise<Event[]> {
  const { rows } = await fixture.query<Event>(
    "SELECT action, actor_kind, actor_user_id, details FROM public.audit_events WHERE organization_id = $1 ORDER BY occurred_at, id",
    [organizationId],
  );
  return rows;
}

const statusOf = async (organizationId: string) =>
  (await fixture.query("SELECT status FROM public.organizations WHERE id = $1", [organizationId])).rows[0].status as string;

const admin = () => f.more.platformAdmin;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Os eventos formam uma cadeia: cada `from` é o `to` anterior e o último `to` é o estado final. */
function assertChain(events: Event[], initial: unknown, final: unknown, label: string) {
  let current = initial;
  for (const event of events) {
    assert.equal(event.details.from, current, `${label}: de/para encadeados ${JSON.stringify(events)}`);
    assert.notEqual(event.details.to, event.details.from, `${label}: só mudança efetiva`);
    current = event.details.to;
  }
  assert.equal(current, final, `${label}: o último evento leva ao estado final`);
}

before(async () => {
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
});

beforeEach(async () => {
  // Estado inicial conhecido para C (manutenção: gera eventos `maintenance`, que os testes filtram).
  await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f.orgC]);
  await fixture.query("DELETE FROM public.organization_modules WHERE organization_id = $1 AND module <> 'atendimento'", [f.orgC]);
});

after(async () => {
  await closeAppPool();
  if (fixture && f) await dropInboxFixtures(fixture, f);
  await fixture?.end();
});

const adminEvents = async (organizationId: string) =>
  (await eventsOf(organizationId)).filter((event) => event.actor_kind === "platform_admin");

test("suspender, reativar, habilitar e desabilitar pela aplicação: um evento cada, com autor e organização", async () => {
  const before = (await adminEvents(f.orgC)).length;
  await setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: "inactive" });
  await setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: "inactive" });
  await setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: "active" });
  await setOrganizationModule({ userId: admin(), organizationId: f.orgC, module: "automacoes", enabled: true });
  await setOrganizationModule({ userId: admin(), organizationId: f.orgC, module: "automacoes", enabled: true });
  await setOrganizationModule({ userId: admin(), organizationId: f.orgC, module: "automacoes", enabled: false });
  await setOrganizationModule({ userId: admin(), organizationId: f.orgC, module: "campanhas", enabled: false });

  const events = (await adminEvents(f.orgC)).slice(before);
  assert.deepEqual(
    events.map((event) => [event.action, event.actor_user_id, event.details]),
    [
      ["organization.suspended", admin(), { from: "active", to: "inactive" }],
      ["organization.reactivated", admin(), { from: "inactive", to: "active" }],
      ["module.enabled", admin(), { module: "automacoes", from: false, to: true }],
      ["module.disabled", admin(), { module: "automacoes", from: true, to: false }],
    ],
  );
  // Nada em outras organizações.
  assert.equal((await adminEvents(f.orgA)).length, 0);
  assert.equal((await adminEvents(f.orgB)).length, 0);
});

test("transação desfeita pela aplicação: nem a alteração nem o evento ficam", async () => {
  const before = (await eventsOf(f.orgC)).length;
  await assert.rejects(
    withUserTransaction(admin(), async (tx) => {
      await tx.query("SELECT public.set_organization_status($1::uuid, 'inactive')", [f.orgC]);
      throw new Error("falha depois da suspensão");
    }),
    /falha depois da suspensão/,
  );
  assert.equal(await statusOf(f.orgC), "active");
  assert.equal((await eventsOf(f.orgC)).length, before);
});

test("duas suspensões simultâneas: a segunda espera a primeira e não gera evento", async () => {
  const before = (await adminEvents(f.orgC)).length;
  const first = withUserTransaction(admin(), async (tx) => {
    const { rows } = await tx.query<{ s: string }>("SELECT public.set_organization_status($1::uuid, 'inactive') AS s", [f.orgC]);
    await sleep(200); // segura a trava da organização
    return rows[0].s;
  });
  await sleep(50);
  const second = setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: "inactive" });
  assert.deepEqual(await Promise.all([first, second]), ["inactive", "inactive"]);
  const events = (await adminEvents(f.orgC)).slice(before);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].details, { from: "active", to: "inactive" });
});

test("suspender e reativar ao mesmo tempo, várias vezes: histórico sempre encadeado e fiel ao estado final", async () => {
  for (let round = 0; round < 8; round += 1) {
    const before = (await adminEvents(f.orgC)).length;
    const initial = await statusOf(f.orgC);
    await Promise.all([
      setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: "inactive" }),
      setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: "active" }),
      setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: round % 2 ? "inactive" : "active" }),
    ]);
    const events = (await adminEvents(f.orgC)).slice(before);
    assertChain(events, initial, await statusOf(f.orgC), `rodada ${round}`);
  }
});

test("habilitar e desabilitar o mesmo módulo ao mesmo tempo: histórico encadeado e fiel ao estado final", async () => {
  const enabledOf = async () =>
    (
      await fixture.query("SELECT coalesce(bool_or(enabled), false) AS on FROM public.organization_modules WHERE organization_id = $1 AND module = 'contatos'", [
        f.orgC,
      ])
    ).rows[0].on as boolean;
  for (let round = 0; round < 8; round += 1) {
    const before = (await adminEvents(f.orgC)).length;
    const initial = await enabledOf();
    await Promise.all([
      setOrganizationModule({ userId: admin(), organizationId: f.orgC, module: "contatos", enabled: true }),
      setOrganizationModule({ userId: admin(), organizationId: f.orgC, module: "contatos", enabled: false }),
      setOrganizationModule({ userId: admin(), organizationId: f.orgC, module: "contatos", enabled: round % 2 === 0 }),
    ]);
    const events = (await adminEvents(f.orgC)).slice(before);
    assert.ok(events.every((event) => event.details.module === "contatos"));
    assertChain(events, initial, await enabledOf(), `rodada ${round}`);
  }
});

test("leitura: só o admin da plataforma vê os eventos; a aplicação não grava nem apaga", async () => {
  await setOrganizationStatus({ userId: admin(), organizationId: f.orgC, status: "inactive" });
  const count = (userId: string) =>
    withUserTransaction(userId, async (tx) =>
      Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_events WHERE organization_id = $1", [f.orgC])).rows[0].n),
    );
  assert.ok((await count(admin())) >= 1);
  for (const userId of [f.more.cOwner, f.users.aOwner, f.users.aAttendant, f.users.bOwner, f.users.nobody]) {
    assert.equal(await count(userId), 0);
  }
  for (const sql of [
    "INSERT INTO public.audit_events (organization_id, actor_kind, action) VALUES ($1, 'maintenance', 'module.enabled')",
    "DELETE FROM public.audit_events WHERE organization_id = $1",
    "UPDATE public.audit_events SET details = '{}' WHERE organization_id = $1",
  ]) {
    await assert.rejects(withUserTransaction(admin(), (tx) => tx.query(sql, [f.orgC])), { code: "42501" });
  }
  await assert.rejects(
    withUserTransaction(admin(), (tx) => tx.query("SELECT public.record_audit_event($1::uuid, 'module.enabled', '{}'::jsonb)", [f.orgC])),
    { code: "42501" },
  );
});
