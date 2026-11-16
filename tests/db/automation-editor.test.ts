/**
 * Entrega E3B — editor de automações pela camada da aplicação, com o pool
 * `antero_app` (sem BYPASSRLS): criar, gravar rascunho sobre a revisão
 * carregada (conflito entre dois administradores), publicar, pausar, reativar,
 * restaurar versão, enviar imagens; permissões, módulo, suspensão e isolamento
 * entre organizações. O dono das tabelas só monta cenários e confere o banco.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError, ModuleDisabledError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { parseFlowDefinition } from "../../src/modules/automations/definition.ts";
import { cleanDefinition, toEditorDefinition, updateStep, type EditorStep } from "../../src/modules/automations/editor.ts";
import {
  createFlow,
  FlowCommandError,
  publishFlow,
  restoreFlowVersion,
  saveFlowDraftById,
  setFlowStatus,
  uploadFlowImage,
} from "../../src/modules/automations/sql-commands.ts";
import {
  getFlowForEditor,
  getFlowImageContent,
  getFlowVersion,
  listFlowImages,
  listFlows,
  listFlowVersions,
} from "../../src/modules/automations/sql-queries.ts";
import { connectFixtureClient, createFixtures, dropFixtures, type Fixtures } from "./harness.ts";

let fixture: pg.Client;
let f: Fixtures;

const ctx = (userId: string, organizationId = f.orgA) => ({ userId, organizationId });
const owner = () => ctx(f.users.aOwner);
const attendant = () => ctx(f.users.aAttendant);
const row = async (sql: string, values: unknown[]) => (await fixture.query(sql, values)).rows[0];

const code = (expected: string) => (error: unknown) => error instanceof FlowCommandError && error.code === expected;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");

/** Rascunho gravado, aberto como o editor abre. */
async function draftOf(flowId: string) {
  const flow = await getFlowForEditor(owner(), flowId);
  assert.ok(flow);
  const definition = toEditorDefinition(flow.draftDefinition);
  assert.ok(definition);
  return { flow, definition };
}

/** Troca o texto da primeira etapa (boas-vindas) e grava sobre a revisão carregada. */
async function editWelcome(flowId: string, text: string, userId = f.users.aOwner) {
  const { flow, definition } = await draftOf(flowId);
  const edited = updateStep(definition, definition.steps[0].id, (step) => ({ ...step, text }) as EditorStep);
  return saveFlowDraftById(ctx(userId), flowId, {
    name: flow.name,
    definition: cleanDefinition(edited),
    isEntry: flow.isEntry,
    expectedRevision: flow.draftRevision,
  });
}

before(async () => {
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  await fixture.query(
    "INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'automacoes', true), ($2, 'automacoes', true)",
    [f.orgA, f.orgB],
  );
});

after(async () => {
  await dropFixtures(fixture, f);
  await fixture.end();
  await closeAppPool();
});

test("criar automação: fluxo inicial publicável, identificador interno único, um só fluxo de entrada", async () => {
  const first = await createFlow(owner(), { name: "Atendimento de Entrada", isEntry: true });
  assert.equal(first.created, true);
  assert.equal(first.draftRevision, 1);
  const { flow, definition } = await draftOf(first.flowId);
  assert.equal(flow.status, "draft");
  assert.equal(flow.publishedVersion, null);
  assert.equal(flow.hasDraftChanges, true);
  assert.equal(flow.draftUpdatedByName, "A Owner");
  assert.ok(parseFlowDefinition(cleanDefinition(definition)).ok, "o fluxo inicial já pode ser publicado");

  const slug = (await row("SELECT slug FROM public.automation_flows WHERE id = $1", [first.flowId])).slug;
  assert.match(slug, /^atendimento-de-entrada-[0-9a-f]{8}$/);
  const twin = await createFlow(owner(), { name: "Atendimento de Entrada", isEntry: false });
  assert.notEqual(twin.flowId, first.flowId, "mesmo nome cria outro fluxo, não sobrescreve");

  await assert.rejects(createFlow(owner(), { name: "Segunda entrada", isEntry: true }), code("entry_conflict"));
  const otherEntry = await getFlowForEditor(owner(), twin.flowId);
  assert.equal(otherEntry?.otherEntryFlowName, "Atendimento de Entrada");
});

test("rascunho incompleto é gravado; publicar exige o fluxo válido e mostra os problemas", async () => {
  const { flowId } = await createFlow(owner(), { name: "Incompleto", isEntry: false });
  const { flow, definition } = await draftOf(flowId);
  const broken = updateStep(definition, definition.steps[0].id, (step) => ({ ...step, text: "", next: "" }) as EditorStep);
  const saved = await saveFlowDraftById(owner(), flowId, {
    name: "Incompleto",
    definition: cleanDefinition(broken),
    isEntry: false,
    expectedRevision: flow.draftRevision,
  });
  assert.equal(saved.draftRevision, flow.draftRevision + 1);
  await assert.rejects(publishFlow(owner(), flowId, saved.draftRevision), (error: unknown) => {
    return error instanceof FlowCommandError && error.code === "invalid_definition" && error.issues.length >= 2;
  });
  assert.equal(Number((await row("SELECT count(*) FROM public.automation_flow_versions WHERE flow_id = $1", [flowId])).count), 0);

  // Não é uma definição v1: nem como rascunho.
  await assert.rejects(
    saveFlowDraftById(owner(), flowId, { name: "X", definition: { schemaVersion: 2, steps: [] }, isEntry: false, expectedRevision: saved.draftRevision }),
    code("invalid_definition"),
  );
});

test("dois administradores no mesmo fluxo: a segunda gravação é recusada, nada é sobrescrito", async () => {
  const { flowId } = await createFlow(owner(), { name: "Concorrência", isEntry: false });
  const { flow, definition } = await draftOf(flowId);
  const version = (text: string) => ({
    name: flow.name,
    definition: cleanDefinition(updateStep(definition, definition.steps[0].id, (step) => ({ ...step, text }) as EditorStep)),
    isEntry: false,
    expectedRevision: flow.draftRevision,
  });

  // Ao mesmo tempo, sobre a mesma revisão: exatamente uma vence.
  const results = await Promise.allSettled([
    saveFlowDraftById(owner(), flowId, version("Texto da pessoa 1")),
    saveFlowDraftById(owner(), flowId, version("Texto da pessoa 2")),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(code("draft_changed")((rejected[0] as PromiseRejectedResult).reason));
  const winner = results[0].status === "fulfilled" ? "Texto da pessoa 1" : "Texto da pessoa 2";
  const stored = await row("SELECT draft_revision, draft_definition FROM public.automation_flows WHERE id = $1", [flowId]);
  assert.equal(stored.draft_revision, flow.draftRevision + 1, "só uma gravação entrou");
  assert.equal(stored.draft_definition.steps[0].text, winner);

  // Depois, com a revisão velha (quem não recarregou): recusada.
  await assert.rejects(saveFlowDraftById(owner(), flowId, version("Atrasado")), code("draft_changed"));
  // E publicar o que não viu também.
  await assert.rejects(publishFlow(owner(), flowId, flow.draftRevision), code("draft_changed"));
});

test("publicar, editar sem afetar a versão publicada, publicar de novo, pausar e reativar", async () => {
  const { flowId } = await createFlow(owner(), { name: "Versões", isEntry: false });
  const v1 = await publishFlow(owner(), flowId, 1);
  assert.equal(v1.version, 1);
  let current = await getFlowForEditor(owner(), flowId);
  assert.equal(current?.status, "active");
  assert.equal(current?.hasDraftChanges, false);

  const saved = await editWelcome(flowId, "Saudação nova (rascunho)");
  current = await getFlowForEditor(owner(), flowId);
  assert.equal(current?.hasDraftChanges, true);
  const published = await getFlowVersion(owner(), flowId, 1);
  assert.equal((published?.definition as { steps: { text?: string }[] }).steps[0].text, "Olá! Seja bem-vindo. Como podemos ajudar?");

  const v2 = await publishFlow(owner(), flowId, saved.draftRevision);
  assert.equal(v2.version, 2);
  const versions = await listFlowVersions(owner(), flowId);
  assert.deepEqual(
    versions.map((version) => [version.version, version.isCurrent, version.publishedByName]),
    [
      [2, true, "A Owner"],
      [1, false, "A Owner"],
    ],
  );
  const v1Row = await row("SELECT definition FROM public.automation_flow_versions WHERE flow_id = $1 AND version = 1", [flowId]);
  assert.equal(v1Row.definition.steps[0].text, "Olá! Seja bem-vindo. Como podemos ajudar?", "versão antiga intacta");

  await setFlowStatus(owner(), flowId, "paused");
  assert.equal((await getFlowForEditor(owner(), flowId))?.status, "paused");
  await setFlowStatus(owner(), flowId, "active");
  assert.equal((await getFlowForEditor(owner(), flowId))?.status, "active");

  const unpublished = await createFlow(owner(), { name: "Nunca publicado", isEntry: false });
  await assert.rejects(setFlowStatus(owner(), unpublished.flowId, "active"), code("not_published"));
});

test("restaurar versão: vira rascunho (nova revisão), sem publicar nem mudar a versão antiga", async () => {
  const { flowId } = await createFlow(owner(), { name: "Restaurar", isEntry: false });
  await publishFlow(owner(), flowId, 1);
  const edited = await editWelcome(flowId, "Versão 2");
  await publishFlow(owner(), flowId, edited.draftRevision);

  const restored = await restoreFlowVersion(owner(), flowId, { version: 1, expectedRevision: edited.draftRevision });
  assert.equal(restored.draftRevision, edited.draftRevision + 1);
  const { flow, definition } = await draftOf(flowId);
  assert.equal(flow.publishedVersion, 2, "restaurar não publica");
  assert.equal(flow.hasDraftChanges, true);
  assert.equal(definition.steps[0].type === "message" && definition.steps[0].text, "Olá! Seja bem-vindo. Como podemos ajudar?");
  const v1 = await getFlowVersion(owner(), flowId, 1);
  assert.deepEqual(
    parseFlowDefinition((await row("SELECT draft_definition FROM public.automation_flows WHERE id = $1", [flowId])).draft_definition),
    parseFlowDefinition(v1?.definition),
  );

  const v3 = await publishFlow(owner(), flowId, restored.draftRevision);
  assert.equal(v3.version, 3, "publicar o restaurado cria uma versão nova");
  assert.equal(Number((await row("SELECT count(*) FROM public.automation_flow_versions WHERE flow_id = $1", [flowId])).count), 3);

  await assert.rejects(restoreFlowVersion(owner(), flowId, { version: 1, expectedRevision: edited.draftRevision }), code("draft_changed"));
  await assert.rejects(restoreFlowVersion(owner(), flowId, { version: 99, expectedRevision: restored.draftRevision }), code("not_found"));
});

test("permissões: atendente lê a lista mas não cria, grava, publica, pausa, restaura nem envia imagem", async () => {
  const { flowId } = await createFlow(owner(), { name: "Permissões", isEntry: false });
  await publishFlow(owner(), flowId, 1);
  assert.ok((await listFlows(attendant())).some((flow) => flow.id === flowId));

  const denied = code("access_denied");
  await assert.rejects(createFlow(attendant(), { name: "Do atendente", isEntry: false }), denied);
  await assert.rejects(editWelcome(flowId, "Do atendente", f.users.aAttendant), denied);
  await assert.rejects(publishFlow(attendant(), flowId), denied);
  await assert.rejects(setFlowStatus(attendant(), flowId, "paused"), denied);
  await assert.rejects(restoreFlowVersion(attendant(), flowId, { version: 1, expectedRevision: 1 }), denied);
  await assert.rejects(uploadFlowImage(attendant(), { fileName: "a.jpg", data: JPEG }), denied);
  // Vínculo desativado e quem não é membro nem entram na organização.
  await assert.rejects(createFlow(ctx(f.users.aDisabled), { name: "X", isEntry: false }), AccessDeniedError);
  await assert.rejects(createFlow(ctx(f.users.nobody), { name: "X", isEntry: false }), AccessDeniedError);
});

test("isolamento: owner de B não lê nem altera fluxos, versões ou imagens de A", async () => {
  const { flowId } = await createFlow(owner(), { name: "Só de A", isEntry: false });
  await publishFlow(owner(), flowId, 1);
  const { mediaId } = await uploadFlowImage(owner(), { fileName: "a.jpg", data: JPEG });
  const ownerB = ctx(f.users.bOwner, f.orgB);

  // Na própria organização, o id de A não existe.
  assert.equal(await getFlowForEditor(ownerB, flowId), null);
  assert.equal(await getFlowVersion(ownerB, flowId, 1), null);
  assert.deepEqual(await listFlowVersions(ownerB, flowId), []);
  assert.equal(await getFlowImageContent(ownerB, mediaId), null);
  assert.ok((await listFlowImages(ownerB)).every((image) => image.id !== mediaId));
  await assert.rejects(publishFlow(ownerB, flowId), code("not_found"));
  await assert.rejects(setFlowStatus(ownerB, flowId, "paused"), code("not_found"));
  await assert.rejects(restoreFlowVersion(ownerB, flowId, { version: 1, expectedRevision: 1 }), code("not_found"));
  await assert.rejects(
    saveFlowDraftById(ownerB, flowId, { name: "X", definition: { schemaVersion: 1, entryStepId: "", steps: [] }, isEntry: false, expectedRevision: 1 }),
    code("not_found"),
  );
  // Fingindo ser da organização A (organizationId manipulado): sem vínculo, recusado.
  await assert.rejects(getFlowForEditor(ctx(f.users.bOwner, f.orgA), flowId), AccessDeniedError);
  await assert.rejects(publishFlow(ctx(f.users.bOwner, f.orgA), flowId), AccessDeniedError);
  assert.equal((await getFlowForEditor(owner(), flowId))?.publishedVersion, 1);
});

test("imagens: JPEG e PNG pela assinatura, mesma imagem reaproveitada, tamanho e formato recusados", async () => {
  const photo = Buffer.concat([JPEG, Buffer.from("programacao")]);
  const first = await uploadFlowImage(owner(), { fileName: "programacao.jpg", data: photo });
  assert.equal(first.created, true);
  const again = await uploadFlowImage(owner(), { fileName: "outro-nome.jpg", data: photo });
  assert.deepEqual(again, { mediaId: first.mediaId, created: false });
  const png = await uploadFlowImage(owner(), { fileName: "logo.png", data: PNG });
  assert.equal(png.created, true);

  const content = await getFlowImageContent(owner(), png.mediaId);
  assert.equal(content?.contentType, "image/png");
  assert.deepEqual(content?.data, PNG);
  const images = await listFlowImages(owner());
  assert.deepEqual(
    images.filter((image) => [first.mediaId, png.mediaId].includes(image.id)).map((image) => image.fileName).sort(),
    ["logo.png", "programacao.jpg"],
  );

  await assert.rejects(uploadFlowImage(owner(), { fileName: "anim.gif", data: GIF }), code("media_type"));
  await assert.rejects(uploadFlowImage(owner(), { fileName: "vazio.jpg", data: Buffer.alloc(0) }), code("media_size"));
  await assert.rejects(
    uploadFlowImage(owner(), { fileName: "grande.jpg", data: Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]) }),
    code("media_size"),
  );
});

test("módulo desligado e organização suspensa: nada é configurado", async () => {
  const { flowId } = await createFlow(owner(), { name: "Bloqueios", isEntry: false });
  await fixture.query("UPDATE public.organization_modules SET enabled = false WHERE organization_id = $1 AND module = 'automacoes'", [f.orgA]);
  try {
    await assert.rejects(createFlow(owner(), { name: "Sem módulo", isEntry: false }), ModuleDisabledError);
    await assert.rejects(editWelcome(flowId, "Sem módulo"), ModuleDisabledError);
    await assert.rejects(publishFlow(owner(), flowId, 1), ModuleDisabledError);
    await assert.rejects(uploadFlowImage(owner(), { fileName: "a.jpg", data: PNG }), ModuleDisabledError);
  } finally {
    await fixture.query("UPDATE public.organization_modules SET enabled = true WHERE organization_id = $1 AND module = 'automacoes'", [f.orgA]);
  }

  await fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [f.orgA]);
  try {
    await assert.rejects(createFlow(owner(), { name: "Suspensa", isEntry: false }), AccessDeniedError);
    await assert.rejects(publishFlow(owner(), flowId, 1), AccessDeniedError);
    await assert.rejects(setFlowStatus(owner(), flowId, "paused"), AccessDeniedError);
    await assert.rejects(getFlowForEditor(owner(), flowId), AccessDeniedError);
  } finally {
    await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f.orgA]);
  }
  assert.equal((await row("SELECT draft_revision FROM public.automation_flows WHERE id = $1", [flowId])).draft_revision, 1);
});
