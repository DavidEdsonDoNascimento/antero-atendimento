/**
 * Entrega E1B — módulos na camada da aplicação: `withModuleTransaction`,
 * consultas reais da Inbox, contexto do DAL e operações do admin da plataforma,
 * com o pool `antero_app` (sem BYPASSRLS). O dono das tabelas só monta cenários.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError, ModuleDisabledError } from "../../src/lib/db/errors.ts";
import { withModuleTransaction } from "../../src/lib/db/organization.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import {
  getConversationDetail,
  listConversationMessages,
  listConversations,
} from "../../src/modules/conversations/sql-queries.ts";
import { ModuleDependencyError, OrganizationNotFoundError } from "../../src/modules/organizations/errors.ts";
import { ORGANIZATION_MODULES } from "../../src/modules/organizations/modules.ts";
import {
  getActiveContext,
  getOrganizationModuleConfiguration,
  listEnabledModules,
  setOrganizationModule,
  setOrganizationStatus,
} from "../../src/modules/organizations/sql-queries.ts";
import { listOrganizationMembers } from "../../src/modules/users/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "./inbox-fixtures.ts";

let fixture: pg.Client;
let f: InboxFixtures;

const setStatus = (organizationId: string, status: "active" | "inactive") =>
  fixture.query("UPDATE public.organizations SET status = $2 WHERE id = $1", [organizationId, status]);

async function setModules(organizationId: string, enabled: string[]) {
  await fixture.query("DELETE FROM public.organization_modules WHERE organization_id = $1", [organizationId]);
  for (const name of enabled) {
    await fixture.query("INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, $2, true)", [
      organizationId,
      name,
    ]);
  }
}

const enabledOf = async (organizationId: string) =>
  (
    await fixture.query(
      "SELECT module::text FROM public.organization_modules WHERE organization_id = $1 AND enabled ORDER BY module",
      [organizationId],
    )
  ).rows.map((row) => row.module as string);

before(async () => {
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
});

afterEach(async () => {
  for (const organizationId of [f.orgA, f.orgB, f.orgC]) {
    await setStatus(organizationId, "active");
    await setModules(organizationId, ["atendimento"]);
  }
});

after(async () => {
  await closeAppPool();
  if (f) await dropInboxFixtures(fixture, f);
  await fixture.end();
});

test("o catálogo da aplicação e o enum do banco têm os mesmos valores", async () => {
  const { rows } = await fixture.query("SELECT unnest(enum_range(NULL::public.organization_module))::text AS module");
  assert.deepEqual(rows.map((row) => row.module), [...ORGANIZATION_MODULES]);
});

test("a dependência do catálogo é a mesma aplicada pela função SQL", async () => {
  const admin = f.more.platformAdmin;
  await assert.rejects(
    setOrganizationModule({ userId: admin, organizationId: f.orgC, module: "campanhas", enabled: true }),
    ModuleDependencyError,
  );
  await setOrganizationModule({ userId: admin, organizationId: f.orgC, module: "contatos", enabled: true });
  await setOrganizationModule({ userId: admin, organizationId: f.orgC, module: "campanhas", enabled: true });
  await assert.rejects(
    setOrganizationModule({ userId: admin, organizationId: f.orgC, module: "contatos", enabled: false }),
    ModuleDependencyError,
  );
  assert.deepEqual(await enabledOf(f.orgC), ["atendimento", "campanhas", "contatos"]);
});

test("withModuleTransaction: callback só com vínculo ativo e módulo habilitado", async () => {
  const ctx = { userId: f.users.aOwner, organizationId: f.orgA };
  assert.equal(await withModuleTransaction(ctx, "atendimento", async () => "ok"), "ok");

  let ran = false;
  const mark = async () => {
    ran = true;
  };
  await assert.rejects(withModuleTransaction(ctx, "campanhas", mark), ModuleDisabledError);
  await assert.rejects(withModuleTransaction(ctx, "campanhas", mark), AccessDeniedError, "continua sendo acesso negado");

  for (const denied of [
    { userId: f.users.bOwner, organizationId: f.orgA },
    { userId: f.users.nobody, organizationId: f.orgA },
    { userId: f.users.aDisabled, organizationId: f.orgA },
    { userId: f.more.platformAdmin, organizationId: f.orgA },
    { userId: f.users.aOwner, organizationId: "nao-e-uuid" },
  ]) {
    await assert.rejects(withModuleTransaction(denied, "atendimento", mark), (error: Error) => {
      assert.ok(error instanceof AccessDeniedError);
      assert.ok(!(error instanceof ModuleDisabledError), "sem vínculo não revela a configuração");
      return true;
    });
  }
  // Módulo inválido falha fechado: o enum do banco recusa.
  await assert.rejects(withModuleTransaction(ctx, "financeiro" as never, mark), { code: "22P02" });
  assert.equal(ran, false);
});

test("a decisão é da transação: desligar entre a leitura do contexto e a operação nega", async () => {
  const context = await getActiveContext({ userId: f.users.aOwner });
  assert.ok(context?.modules.includes("atendimento"));

  await setOrganizationModule({ userId: f.more.platformAdmin, organizationId: f.orgA, module: "atendimento", enabled: false });
  // O contexto antigo ainda diz que há módulo; o banco decide.
  await assert.rejects(
    listConversations({ userId: context!.userId, organizationId: context!.organization.id }),
    ModuleDisabledError,
  );
});

test("Inbox: sem Atendimento as consultas recusam; os dados continuam lá; religar restaura", async () => {
  const ctx = { userId: f.users.aOwner, organizationId: f.orgA };
  const { items } = await listConversations(ctx, { limit: 50 });
  assert.ok(items.length > 0);
  const messagesBefore = (await fixture.query("SELECT count(*)::int AS n FROM public.messages WHERE organization_id = $1", [f.orgA])).rows[0].n;

  await setModules(f.orgA, []);
  await assert.rejects(listConversations(ctx), ModuleDisabledError);
  await assert.rejects(getConversationDetail(ctx, f.conv.cH), ModuleDisabledError);
  await assert.rejects(listConversationMessages(ctx, f.conv.cH), ModuleDisabledError);
  // O núcleo continua: equipe não depende de módulo.
  assert.ok((await listOrganizationMembers(ctx)).length > 0);
  // Desligar não apaga nada.
  assert.equal(
    (await fixture.query("SELECT count(*)::int AS n FROM public.messages WHERE organization_id = $1", [f.orgA])).rows[0].n,
    messagesBefore,
  );

  await setModules(f.orgA, ["atendimento"]);
  assert.deepEqual((await listConversations(ctx, { limit: 50 })).items.map((item) => item.id), items.map((item) => item.id));
});

test("um módulo de A não libera B, e outra empresa segue operando", async () => {
  await setModules(f.orgA, ["atendimento", "contatos", "campanhas"]);
  await setModules(f.orgB, []);
  await assert.rejects(listConversations({ userId: f.users.bOwner, organizationId: f.orgB }), ModuleDisabledError);
  assert.ok((await listConversations({ userId: f.users.aOwner, organizationId: f.orgA })).items.length > 0);
  // Informar a organização de A com a sessão de B não adianta.
  await assert.rejects(listConversations({ userId: f.users.bOwner, organizationId: f.orgA }), (error: Error) => {
    assert.ok(error instanceof AccessDeniedError && !(error instanceof ModuleDisabledError));
    return true;
  });
});

test("contexto do DAL: módulos da organização ativa, atualizados a cada leitura", async () => {
  await setModules(f.orgA, ["automacoes", "atendimento"]);
  assert.deepEqual((await getActiveContext({ userId: f.users.aOwner }))?.modules, ["atendimento", "automacoes"]);
  await setModules(f.orgA, []);
  assert.deepEqual((await getActiveContext({ userId: f.users.aOwner }))?.modules, []);
});

test("duas organizações: cada contexto com as próprias permissões", async () => {
  const userId = f.more.multi;
  await setModules(f.orgB, ["contatos"]);
  await setModules(f.orgA, ["atendimento"]);

  const context = await getActiveContext({ userId });
  assert.equal(context?.organization.id, f.orgB);
  assert.deepEqual(context?.modules, ["contatos"]);
  await assert.rejects(listConversations({ userId, organizationId: f.orgB }), ModuleDisabledError);
  assert.ok((await listConversations({ userId, organizationId: f.orgA })).items.length > 0);

  await setStatus(f.orgB, "inactive");
  const switched = await getActiveContext({ userId });
  assert.equal(switched?.organization.id, f.orgA);
  assert.deepEqual(switched?.modules, ["atendimento"]);
});

test("suspensão prevalece; o admin ajusta a suspensa e a reativação preserva", async () => {
  const admin = f.more.platformAdmin;
  const ctx = { userId: f.users.aOwner, organizationId: f.orgA };
  await setOrganizationModule({ userId: admin, organizationId: f.orgA, module: "contatos", enabled: true });

  await setOrganizationStatus({ userId: admin, organizationId: f.orgA, status: "inactive" });
  await assert.rejects(withModuleTransaction(ctx, "atendimento", async () => "x"), (error: Error) => {
    assert.ok(error instanceof AccessDeniedError && !(error instanceof ModuleDisabledError));
    return true;
  });
  assert.equal(await getActiveContext({ userId: f.users.aOwner }), null);
  await setOrganizationModule({ userId: admin, organizationId: f.orgA, module: "automacoes", enabled: true });

  await setOrganizationStatus({ userId: admin, organizationId: f.orgA, status: "active" });
  assert.deepEqual((await getActiveContext({ userId: f.users.aOwner }))?.modules, ["atendimento", "automacoes", "contatos"]);
  assert.ok((await listConversations(ctx)).items.length > 0);
});

test("operações do admin: só o admin da plataforma, sem vínculo; demais papéis → AccessDeniedError", async () => {
  const admin = f.more.platformAdmin;
  const denied = [f.users.aOwner, f.users.aAttendant, f.users.bOwner, f.users.nobody, f.users.aDisabled];
  for (const userId of denied) {
    await assert.rejects(setOrganizationModule({ userId, organizationId: f.orgA, module: "contatos", enabled: true }), AccessDeniedError);
    await assert.rejects(listEnabledModules({ userId }), AccessDeniedError);
    await assert.rejects(getOrganizationModuleConfiguration({ userId, organizationId: f.orgA }), AccessDeniedError);
  }
  assert.deepEqual(await enabledOf(f.orgA), ["atendimento"]);

  assert.equal(await setOrganizationModule({ userId: admin, organizationId: f.orgA, module: "contatos", enabled: true }), true);
  const configuration = await getOrganizationModuleConfiguration({ userId: admin, organizationId: f.orgA });
  assert.equal(configuration?.organization.id, f.orgA);
  const setting = configuration?.settings.find((row) => row.module === "contatos");
  assert.equal(setting?.enabled, true);
  assert.equal(setting?.updated_by_name, "Admin Plataforma");
  assert.ok((await listEnabledModules({ userId: admin })).some((row) => row.organization_id === f.orgA && row.module === "contatos"));
  assert.equal(await getOrganizationModuleConfiguration({ userId: admin, organizationId: "00000000-0000-4000-8000-000000000000" }), null);
  await assert.rejects(
    setOrganizationModule({ userId: admin, organizationId: "00000000-0000-4000-8000-000000000000", module: "contatos", enabled: true }),
    OrganizationNotFoundError,
  );
});

test("escrita direta pela conexão da aplicação: negada para todos os papéis", async () => {
  const writes = [
    "INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'campanhas', true)",
    "UPDATE public.organization_modules SET enabled = false WHERE organization_id = $1",
    "DELETE FROM public.organization_modules WHERE organization_id = $1",
  ];
  for (const userId of [f.users.aOwner, f.users.aAttendant, f.more.platformAdmin]) {
    for (const sql of writes) {
      await assert.rejects(withUserTransaction(userId, (tx) => tx.query(sql, [f.orgA])), { code: "42501" }, sql);
    }
  }
  assert.deepEqual(await enabledOf(f.orgA), ["atendimento"]);
});

test("concorrência: repetir não duplica, e a dependência resiste a alterações simultâneas", async () => {
  const admin = f.more.platformAdmin;
  await Promise.all(
    Array.from({ length: 8 }, () => setOrganizationModule({ userId: admin, organizationId: f.orgC, module: "automacoes", enabled: true })),
  );
  const { rows } = await fixture.query(
    "SELECT count(*)::int AS n FROM public.organization_modules WHERE organization_id = $1 AND module = 'automacoes'",
    [f.orgC],
  );
  assert.equal(rows[0].n, 1);

  // Corrida entre ligar Campanhas e desligar Contatos: sem a trava, os dois
  // veriam o estado antigo e Campanhas ficaria ligado sem Contatos.
  for (let round = 0; round < 15; round += 1) {
    await setModules(f.orgC, ["contatos"]);
    await Promise.allSettled([
      setOrganizationModule({ userId: admin, organizationId: f.orgC, module: "campanhas", enabled: true }),
      setOrganizationModule({ userId: admin, organizationId: f.orgC, module: "contatos", enabled: false }),
    ]);
    const enabled = await enabledOf(f.orgC);
    assert.ok(!enabled.includes("campanhas") || enabled.includes("contatos"), `rodada ${round}: ${enabled}`);
  }
});

test("usuário apagado: a configuração fica, sem responsável", async () => {
  const { rows } = await fixture.query(
    "SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.organization_modules'::regclass AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.organization_modules'::regclass AND attname = 'updated_by')]::smallint[]",
  );
  assert.equal(rows[0].confdeltype, "n", "ON DELETE SET NULL");
});
