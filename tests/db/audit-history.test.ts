/**
 * G2C — leitura do histórico de atividades administrativas pela camada da
 * aplicação (pool `antero_app`, sem BYPASSRLS): só o admin da plataforma lê,
 * a consulta da organização não traz eventos de outra, a ordem é total e a
 * paginação por cursor não repete nem pula eventos, os filtros de período
 * seguem os dias de Brasília e autores e organizações removidos não somem.
 *
 * O dono das tabelas (cliente de fixtures) só monta cenários: eventos
 * sintéticos com instante escolhido numa organização própria do teste e
 * alterações por SQL (manutenção). Os eventos são imutáveis e se acumulam no
 * banco de testes; as conferências se limitam às organizações deste teste.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError, InvalidUserContextError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { AUDIT_ACTIONS } from "../../src/modules/audit/catalog.ts";
import { encodeAuditEventCursor } from "../../src/modules/audit/cursor.ts";
import { InvalidAuditCursorError, InvalidAuditFilterError } from "../../src/modules/audit/errors.ts";
import { listAuditEvents } from "../../src/modules/audit/sql-queries.ts";
import type { AuditEventItem } from "../../src/modules/audit/types.ts";
import { connectFixtureClient, createExtraUsers } from "./harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "./inbox-fixtures.ts";

let fixture: pg.Client;
let f: InboxFixtures;
let orgD: string;
let orgGone: string;
let extra: { removed: string; unnamed: string };

const admin = () => ({ userId: f.more.platformAdmin });

/**
 * Eventos de D, em ordem cronológica. 02:59:59.999999Z de 10/03 é 23:59:59.999999 de 09/03 em Brasília;
 * 03:00Z de 10/03 já é 00:00 de 10/03. Três eventos empatados às 15:00Z (desempate pelo id).
 */
const D_EVENTS: Array<[string, string, string]> = [
  ["2026-03-09 12:00:00+00", "organization.suspended", '{"from":"active","to":"inactive"}'],
  ["2026-03-10 02:59:59.999999+00", "organization.reactivated", '{"from":"inactive","to":"active"}'],
  ["2026-03-10 03:00:00+00", "module.enabled", '{"module":"contatos","from":false,"to":true}'],
  ["2026-03-10 15:00:00+00", "module.disabled", '{"module":"contatos","from":true,"to":false}'],
  ["2026-03-10 15:00:00+00", "module.enabled", '{"module":"campanhas","from":false,"to":true}'],
  ["2026-03-10 15:00:00+00", "module.disabled", '{"module":"campanhas","from":true,"to":false}'],
  ["2026-03-11 02:59:59.999999+00", "organization.suspended", '{"from":"active","to":"inactive"}'],
];

async function insertEvent(organizationId: string, occurredAt: string, action: string, details: string, actor: string | null) {
  await fixture.query(
    `INSERT INTO public.audit_events (organization_id, actor_user_id, actor_kind, action, details, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
    [organizationId, actor, actor ? "platform_admin" : "maintenance", action, details, occurredAt],
  );
}

/** Ids na ordem esperada, calculados pelo dono das tabelas (sem RLS). */
async function referenceIds(organizationId: string): Promise<string[]> {
  const { rows } = await fixture.query(
    "SELECT id::text FROM public.audit_events WHERE organization_id = $1 ORDER BY occurred_at DESC, id DESC",
    [organizationId],
  );
  return rows.map((row) => row.id);
}

async function allPages(params: Parameters<typeof listAuditEvents>[1], limit: number): Promise<AuditEventItem[][]> {
  const pages: AuditEventItem[][] = [];
  let cursor: string | undefined;
  do {
    const page = await listAuditEvents(admin(), { ...params, cursor, limit });
    pages.push(page.items);
    cursor = page.nextCursor ?? undefined;
    assert.ok(pages.length < 500, "paginação termina");
  } while (cursor);
  return pages;
}

/** Contagem e md5 dos eventos deste teste, para provar que a leitura não muda nada. */
async function fingerprint(): Promise<string> {
  const { rows } = await fixture.query(
    `SELECT count(*)::text || ':' || coalesce(md5(string_agg(e::text, ',' ORDER BY e.id)), '') AS fp
     FROM public.audit_events e WHERE e.organization_id = ANY($1::uuid[])`,
    [[f.orgA, f.orgB, f.orgC, orgD, orgGone]],
  );
  return rows[0].fp;
}

before(async () => {
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
  extra = await createExtraUsers(f.suffix, { removed: "Autora Removida", unnamed: "Sem Nome" });
  await fixture.query("UPDATE public.profiles SET full_name = NULL WHERE id = $1", [extra.unnamed]);

  const org = async (name: string, slug: string) =>
    (await fixture.query("INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id", [name, `${slug}-${f.suffix}`]))
      .rows[0].id as string;
  orgD = await org("Org D Auditoria", "org-d");
  orgGone = await org("Org Excluída", "org-gone");

  for (const [at, action, details] of D_EVENTS) await insertEvent(orgD, at, action, details, f.more.platformAdmin);
  // Autoria: usuário que será removido, perfil sem nome e manutenção (alteração por SQL do operador).
  await insertEvent(orgD, "2026-03-12 12:00:00+00", "organization.suspended", '{"from":"active","to":"inactive"}', extra.removed);
  await insertEvent(orgD, "2026-03-12 12:00:01+00", "organization.reactivated", '{"from":"inactive","to":"active"}', extra.unnamed);
  await fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [orgD]);
  await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [orgD]);
  await fixture.query("DELETE FROM auth.users WHERE id = $1", [extra.removed]);

  // Organização com histórico e depois excluída pela manutenção.
  await insertEvent(orgGone, "2026-03-12 13:00:00+00", "module.enabled", '{"module":"contatos","from":false,"to":true}', f.more.platformAdmin);
  await fixture.query("DELETE FROM public.organizations WHERE id = $1", [orgGone]);

  // Eventos reais, um em A e outro em B, para o isolamento entre organizações.
  for (const organizationId of [f.orgA, f.orgB]) {
    await fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [organizationId]);
    await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [organizationId]);
  }
});

after(async () => {
  await closeAppPool();
  if (fixture && f) {
    await fixture.query("DELETE FROM public.organizations WHERE id = $1", [orgD]);
    await fixture.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [Object.values(extra ?? {})]);
    await dropInboxFixtures(fixture, f);
  }
  await fixture?.end();
});

test("catálogo de operações igual ao CHECK de audit_events (0013)", async () => {
  const { rows } = await fixture.query(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'audit_events_action' AND conrelid = 'public.audit_events'::regclass",
  );
  const inCheck = [...rows[0].def.matchAll(/'([a-z_.]+)'::text/g)].map((match) => match[1]).sort();
  assert.deepEqual(inCheck, [...AUDIT_ACTIONS].sort());
});

test("só o admin da plataforma lê; owner, admin, atendente, desativado, sem vínculo e multiorganização são recusados", async () => {
  const page = await listAuditEvents(admin(), { filters: { organizationId: orgD } });
  assert.ok(page.items.length > 0);
  for (const userId of [f.users.aOwner, f.users.aAttendant, f.users.aDisabled, f.users.bOwner, f.users.nobody, f.more.cOwner, f.more.multi]) {
    await assert.rejects(listAuditEvents({ userId }, { filters: { organizationId: orgD } }), AccessDeniedError, userId);
    await assert.rejects(listAuditEvents({ userId }), AccessDeniedError, userId);
  }
  for (const userId of ["", "nao-e-uuid"]) await assert.rejects(listAuditEvents({ userId }), InvalidUserContextError);
});

test("filtro inválido vindo de código (sem passar pela validação) é recusado antes do banco", async () => {
  for (const filters of [
    { organizationId: "nao-e-uuid" },
    { action: "support.started" as never },
    { from: "2026-02-30" },
    { to: "18/11/2026" },
  ]) {
    await assert.rejects(listAuditEvents(admin(), { filters }), InvalidAuditFilterError, JSON.stringify(filters));
  }
});

test("organização: só os eventos dela, mais recentes primeiro; a global traz as demais", async () => {
  for (const organizationId of [f.orgA, f.orgB, orgD]) {
    const items = (await allPages({ filters: { organizationId } }, 50)).flat();
    assert.deepEqual(items.map((item) => item.id), await referenceIds(organizationId), organizationId);
    assert.ok(items.every((item) => item.organization.id === organizationId), organizationId);
  }
  // A também tem o `module.enabled` da criação das fixtures (manutenção).
  const ofA = (await listAuditEvents(admin(), { filters: { organizationId: f.orgA } })).items.slice(0, 2);
  assert.deepEqual(ofA.map((item) => [item.title, item.actor.kind]), [
    ["Organização reativada", "maintenance"],
    ["Organização suspensa", "maintenance"],
  ]);
  assert.equal(ofA[0].organization.name, "Org A Integração");

  // Global (todas as páginas desde março, para não varrer eventos de outras execuções): contém os de
  // A, B, D e da organização excluída na mesma ordem relativa da referência.
  const global = (await allPages({ filters: { from: "2026-03-01" } }, 50)).flat();
  const ids = new Set(global.map((item) => item.id));
  assert.equal(ids.size, global.length, "sem duplicidade na global");
  for (const organizationId of [f.orgA, f.orgB, orgD, orgGone]) {
    assert.deepEqual(
      global.filter((item) => item.organization.id === organizationId).map((item) => item.id),
      await referenceIds(organizationId),
      `global: ${organizationId}`,
    );
  }
});

test("ordem total com instantes iguais e paginação por cursor sem repetir nem pular", async () => {
  const reference = await referenceIds(orgD);
  for (const limit of [1, 2, 3, 4]) {
    const pages = await allPages({ filters: { organizationId: orgD } }, limit);
    assert.deepEqual(pages.flat().map((item) => item.id), reference, `limite ${limit}`);
    assert.ok(pages.slice(0, -1).every((page) => page.length === limit), `páginas cheias (limite ${limit})`);
    assert.ok(pages.at(-1)!.length >= 1 && pages.at(-1)!.length <= limit, `última página (limite ${limit})`);
  }
  // Os três empatados às 15:00Z saem por id decrescente.
  const tied = (await listAuditEvents(admin(), { filters: { organizationId: orgD, from: "2026-03-10", to: "2026-03-10" } })).items.filter(
    (item) => item.occurredAt === "2026-03-10T15:00:00+00:00",
  );
  assert.equal(tied.length, 3);
  assert.deepEqual(tied.map((item) => item.id), [...tied.map((item) => item.id)].sort((a, b) => Number(b) - Number(a)));
  // Página exata: com 25 por página e menos eventos, nenhuma página seguinte.
  assert.equal((await listAuditEvents(admin(), { filters: { organizationId: orgD } })).nextCursor, null);
});

test("período pelos dias de Brasília, com o último dia inteiro, e filtros combinados com o cursor", async () => {
  const titlesAt = async (from?: string, to?: string, action?: (typeof AUDIT_ACTIONS)[number]) =>
    (await listAuditEvents(admin(), { filters: { organizationId: orgD, from, to, action } })).items.map((item) => item.occurredAt);

  // 02:59:59.999999Z de 10/03 ainda é 09/03 em Brasília; 03:00Z já é 10/03.
  assert.deepEqual(await titlesAt("2026-03-09", "2026-03-09"), ["2026-03-10T02:59:59.999999+00:00", "2026-03-09T12:00:00+00:00"]);
  assert.deepEqual(await titlesAt("2026-03-10", "2026-03-10"), [
    "2026-03-11T02:59:59.999999+00:00",
    "2026-03-10T15:00:00+00:00",
    "2026-03-10T15:00:00+00:00",
    "2026-03-10T15:00:00+00:00",
    "2026-03-10T03:00:00+00:00",
  ]);
  assert.deepEqual(await titlesAt(undefined, "2026-03-08"), []);
  assert.equal((await titlesAt("2026-03-12")).length, 4, "só data inicial: 2 sintéticos + 2 de manutenção");

  // Tipo + período, paginado de um em um.
  const enabled = (await allPages({ filters: { organizationId: orgD, action: "module.enabled", from: "2026-03-10", to: "2026-03-10" } }, 1)).flat();
  assert.deepEqual(enabled.map((item) => [item.title, item.module, item.occurredAt]), [
    ["Módulo habilitado", "Campanhas", "2026-03-10T15:00:00+00:00"],
    ["Módulo habilitado", "Contatos", "2026-03-10T03:00:00+00:00"],
  ]);
});

test("cursor adulterado, fora do intervalo ou recusado pelo PostgreSQL: InvalidAuditCursorError", async () => {
  for (const cursor of [
    "lixo",
    Buffer.from('{"occurredAt":"2026-03-10T00:00:00Z","id":"9223372036854775808"}').toString("base64url"),
    // Formato ISO aceito, mas ano 0000 é recusado pelo PostgreSQL (22008).
    encodeAuditEventCursor({ occurredAt: "0000-01-01T00:00:00Z", id: "1" }),
  ]) {
    await assert.rejects(listAuditEvents(admin(), { filters: { organizationId: orgD }, cursor }), InvalidAuditCursorError, cursor);
  }
  // Cursor válido além do último evento: página vazia, sem erro.
  const page = await listAuditEvents(admin(), {
    filters: { organizationId: orgD },
    cursor: encodeAuditEventCursor({ occurredAt: "2000-01-01T00:00:00Z", id: "1" }),
  });
  assert.deepEqual(page, { items: [], nextCursor: null });
});

test("manutenção, autor removido, perfil sem nome e organização excluída: eventos preservados, nada interno exposto", async () => {
  const items = (await listAuditEvents(admin(), { filters: { organizationId: orgD, from: "2026-03-12" } })).items;
  const maintenance = items.filter((item) => item.actor.kind === "maintenance");
  assert.equal(maintenance.length, 2);
  assert.ok(maintenance.every((item) => item.actor.label === "Manutenção — alteração direta no banco"));
  assert.deepEqual(maintenance.map((item) => item.change), [
    { from: "Suspensa", to: "Ativa" },
    { from: "Ativa", to: "Suspensa" },
  ]);
  assert.deepEqual(items.slice(-2).map((item) => [item.title, item.actor]), [
    ["Organização reativada", { kind: "platform_admin", label: "Usuário sem nome", removed: false }],
    ["Organização suspensa", { kind: "platform_admin", label: "Usuário removido", removed: true }],
  ]);
  // O operador do banco (db_role) e os ids internos do autor não chegam à tela.
  const serialized = JSON.stringify(items);
  for (const internal of ["antero_migrator", "antero_owner", "db_role", "details", "@teste.local", extra.removed, extra.unnamed]) {
    assert.ok(!serialized.includes(internal), internal);
  }

  const gone = (await listAuditEvents(admin(), { filters: { organizationId: orgGone } })).items;
  assert.equal(gone.length, 1);
  assert.deepEqual(gone[0].organization, { id: orgGone, name: null, shortId: orgGone.slice(0, 8) });
  assert.equal(gone[0].title, "Módulo habilitado");
  assert.equal(gone[0].actor.label, "Admin Plataforma");
  const inGlobal = (await allPages({ filters: { from: "2026-03-12", to: "2026-03-12" } }, 50)).flat();
  assert.ok(inGlobal.some((item) => item.id === gone[0].id && item.organization.name === null), "global mantém a organização excluída");
});

test("a leitura não altera o histórico", async () => {
  const before = await fingerprint();
  await allPages({ filters: { from: "2026-03-01" } }, 7);
  for (const organizationId of [f.orgA, orgD, orgGone]) await allPages({ filters: { organizationId } }, 2);
  await listAuditEvents(admin(), { filters: { action: "module.enabled", from: "2026-03-01", to: "2026-03-31" } });
  assert.equal(await fingerprint(), before);
});
