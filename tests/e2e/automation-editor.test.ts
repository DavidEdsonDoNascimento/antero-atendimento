/**
 * Entrega E3B — editor de automações ponta a ponta contra a aplicação Next.js
 * REAL (`pnpm app:e2e`: `next dev` isolado sobre o banco de TESTES), por HTTP
 * como o navegador: owner cria a automação → monta menu, pergunta e destinos →
 * salva → publica → cliente simulado conversa com a versão publicada → owner
 * altera o rascunho sem afetar quem conversa → publica a versão 2 → vê e
 * restaura a versão 1. Permissões: atendente, outra organização, revisão velha
 * e organização manipulada não alteram nada. A prévia roda no navegador (só
 * memória); aqui ela é conferida pelo mesmo módulo, sobre o rascunho gravado.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { closeAppPool } from "../../src/lib/db/pool.ts";
import { parseFlowDefinition } from "../../src/modules/automations/definition.ts";
import {
  addOption,
  cleanDefinition,
  insertStep,
  newStep,
  toEditorDefinition,
  updateOption,
  updateStep,
  type EditorDefinition,
  type EditorMenuStep,
  type EditorStep,
} from "../../src/modules/automations/editor.ts";
import { EMPTY_PREVIEW, previewReply } from "../../src/modules/automations/preview.ts";
import { uploadFlowImage } from "../../src/modules/automations/sql-commands.ts";
import { createLocalProvisioner } from "../../src/lib/identity/provision.ts";
import { connectFixtureClient, createFixtures, dropFixtures, type Fixtures } from "../db/harness.ts";
import { createTestIdentity, uniqueIp, type TestIdentity } from "../db/identity-harness.ts";

const BASE = process.env.E2E_BASE_URL as string;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;

let identity: TestIdentity;
let fixture: pg.Client;
let f: Fixtures;
const passwords = new Map<string, string>();

type Who = "aOwner" | "aAttendant" | "bOwner";
const emailOf = (who: Who) =>
  ({
    aOwner: `a-owner.${f.suffix}@teste.local`,
    aAttendant: `a-attendant.${f.suffix}@teste.local`,
    bOwner: `b-owner.${f.suffix}@teste.local`,
  })[who];

/** Navegador mínimo (mesmo protocolo de tests/e2e/automation.test.ts). */
class Client {
  readonly cookies = new Map<string, string>();
  readonly ip = uniqueIp();

  private headers(extra: Record<string, string> = {}) {
    const headers = new Headers({ "x-forwarded-for": this.ip, ...extra });
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    return headers;
  }

  private keep(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return response;
  }

  async signIn(who: Who) {
    const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", origin: ORIGIN }),
      body: JSON.stringify({ email: emailOf(who), password: passwords.get(who) }),
      redirect: "manual",
    });
    assert.equal(response.status, 200, `login de ${who}`);
    this.keep(response);
    return this;
  }

  async page(path: string) {
    const response = this.keep(await fetch(`${BASE}${path}`, { headers: this.headers(), redirect: "manual" }));
    // Sem os marcadores entre textos do React ("Versão <!-- -->2").
    const html = response.status === 200 ? (await response.text()).replaceAll("<!-- -->", "") : "";
    const streamed = /NEXT_REDIRECT;(?:replace|push);([^;]+);/.exec(html)?.[1];
    const location = response.headers.get("location");
    return { status: response.status, redirect: location ? new URL(location, BASE).pathname : (streamed ?? null), html };
  }

  async raw(path: string) {
    return fetch(`${BASE}${path}`, { headers: this.headers(), redirect: "manual" });
  }

  async action(path: string, actionId: string, fields: Record<string, string>) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(`_1_${name}`, value);
    form.set("0", JSON.stringify(["$undefined", "$K1"]));
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: this.headers({ origin: ORIGIN, "next-action": actionId, accept: "text/x-component" }),
      body: form,
      redirect: "manual",
    });
    return { status: response.status, text: await response.text(), redirect: response.headers.get("x-action-redirect") };
  }
}

const login = (who: Who) => new Client().signIn(who);

function actionIdIn(html: string, marker: string): string {
  const form = html.split("<form").find((segment) => segment.includes(marker));
  assert.ok(form, `formulário com ${marker}`);
  const id =
    /&quot;id&quot;:&quot;([0-9a-f]{20,})&quot;/.exec(form!)?.[1] ??
    /\$ACTION_ID_([0-9a-f]{20,})/.exec(form!)?.[1];
  assert.ok(id, `id da ação no formulário com ${marker}`);
  return id!;
}

const row = async (sql: string, values: unknown[]) => (await fixture.query(sql, values)).rows[0];
const flowRow = (flowId: string) =>
  row("SELECT draft_revision, draft_definition, published_version_id, status FROM public.automation_flows WHERE id = $1", [flowId]);
const versionCount = async (flowId: string) =>
  (await row("SELECT count(*)::int AS n FROM public.automation_flow_versions WHERE flow_id = $1", [flowId])).n as number;

/** Conteúdo de uma gravação, como a tela serializa. */
const snapshotOf = (name: string, isEntry: boolean, definition: EditorDefinition) =>
  JSON.stringify({ name, isEntry, definition: cleanDefinition(definition) });

before(async () => {
  assert.ok(BASE?.startsWith("http://127.0.0.1:"), "use `pnpm app:e2e`");
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  await fixture.query(
    "INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'automacoes', true), ($2, 'automacoes', true)",
    [f.orgA, f.orgB],
  );
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  for (const who of ["aOwner", "aAttendant", "bOwner"] as Who[]) {
    const result = await provisioner.provision({ email: emailOf(who), name: who, rotatePassword: true });
    passwords.set(who, result.password as string);
  }
});

after(async () => {
  for (const org of [f.orgA, f.orgB]) {
    await fixture.query("DELETE FROM public.messages WHERE organization_id = $1", [org]);
    await fixture.query("DELETE FROM public.conversations WHERE organization_id = $1", [org]);
    await fixture.query("DELETE FROM public.automation_flows WHERE organization_id = $1", [org]);
  }
  await dropFixtures(fixture, f);
  await fixture.end();
  await identity.close();
  await closeAppPool();
});

test("owner cria, monta, salva, testa, publica, altera, publica de novo e restaura uma automação", async () => {
  const owner = await login("aOwner");

  // 1) Área de automações vazia; 2) criar.
  const list = await owner.page("/fluxos");
  assert.equal(list.status, 200);
  assert.match(list.html, /Nenhuma automação ainda/);
  // Estado do módulo: editor disponível, WhatsApp real ainda depende de integrações.
  assert.match(list.html, /O editor está disponível/);
  assert.match(list.html, /depende de integrações em desenvolvimento/);
  const createPage = await owner.page("/fluxos/novo");
  const createId = actionIdIn(createPage.html, 'name="name"');
  const created = await owner.action("/fluxos/novo", createId, { name: "Atendimento do Sítio (fictício)", isEntry: "on" });
  const flow = await row("SELECT id, is_entry, status, draft_revision FROM public.automation_flows WHERE organization_id = $1", [f.orgA]);
  assert.ok(flow, created.text.slice(0, 300));
  assert.match(created.redirect ?? "", new RegExp(`/fluxos/${flow.id}`));
  assert.deepEqual([flow.is_entry, flow.status, flow.draft_revision], [true, "draft", 1]);

  // 3–4) Editor: boas-vindas, menu com reserva (pergunta) e equipe.
  const editorPath = `/fluxos/${flow.id}`;
  const editor = await owner.page(editorPath);
  assert.equal(editor.status, 200);
  assert.match(editor.html, /Boas-vindas/);
  assert.match(editor.html, /Ainda não publicada/);
  const saveId = actionIdIn(editor.html, 'name="snapshot"');
  const publishId = actionIdIn(editor.html, "Publicar versão");

  let definition = toEditorDefinition((await flowRow(flow.id)).draft_definition)!;
  const [welcome, menu] = definition.steps as [EditorStep, EditorMenuStep];
  const question = { ...newStep(definition, "question"), text: "Qual é o seu nome?", label: "Nome", variable: "nome" } as EditorStep;
  definition = insertStep(definition, question, menu.id);
  const done = { ...newStep(definition, "end"), text: "Recebemos seu pedido. A equipe confirma a reserva." } as EditorStep;
  definition = insertStep(definition, done, question.id);
  definition = updateStep(definition, question.id, (step) => ({ ...step, next: done.id }) as EditorStep);
  definition = addOption(definition, menu.id);
  const reserveOption = (definition.steps[1] as EditorMenuStep).options[1];
  definition = updateOption(definition, menu.id, reserveOption.id, (option) => ({ ...option, title: "Fazer uma reserva", next: question.id }));
  definition = updateStep(definition, welcome.id, (step) => ({ ...step, text: "Olá! Bem-vindo ao Sítio Exemplo." }) as EditorStep);

  // 5) Salvar sobre a revisão carregada.
  const v1Snapshot = snapshotOf("Atendimento do Sítio (fictício)", true, definition);
  const saved = await owner.action(editorPath, saveId, { flowId: flow.id, expectedRevision: "1", snapshot: v1Snapshot });
  assert.match(saved.text, /Rascunho salvo/);
  assert.equal((await flowRow(flow.id)).draft_revision, 2);

  // 6) Prévia: o mesmo motor, sobre o rascunho gravado, sem gravar nada.
  const messagesBefore = (await row("SELECT count(*)::int AS n FROM public.messages WHERE organization_id = $1", [f.orgA])).n;
  const draft = parseFlowDefinition((await flowRow(flow.id)).draft_definition);
  assert.ok(draft.ok);
  let preview = previewReply(draft.definition, EMPTY_PREVIEW, { type: "text", text: "Oi" }, "Oi", { humanHandoffAvailable: true });
  preview = previewReply(draft.definition, preview, { type: "selection", optionId: reserveOption.id }, "Fazer uma reserva", { humanHandoffAvailable: true });
  preview = previewReply(draft.definition, preview, { type: "text", text: "Ana Teste" }, "Ana Teste", { humanHandoffAvailable: true });
  assert.equal(preview.status, "completed");
  assert.deepEqual(preview.state?.answers, [{ key: "nome", label: "Nome", value: "Ana Teste" }]);
  assert.equal((await row("SELECT count(*)::int AS n FROM public.messages WHERE organization_id = $1", [f.orgA])).n, messagesBefore);

  // 7) Publicar a versão 1.
  const published = await owner.action(editorPath, publishId, { flowId: flow.id, expectedRevision: "2" });
  assert.match(published.text, /Versão 1 publicada/);
  assert.equal(await versionCount(flow.id), 1);

  // Cliente simulado conversa com a versão publicada.
  const simulateId = actionIdIn((await owner.page(`/simulador?canal=${f.accountA}`)).html, 'name="phoneNumber"');
  const customer = (phone: string) => (content: string) =>
    owner.action("/simulador", simulateId, { channelId: f.accountA, phoneNumber: phone, contactName: "Cliente Editor", content, repeatExternalId: "" });
  const first = customer("+5511955559101");
  assert.match((await first("Oi")).text, /Bem-vindo ao Sítio Exemplo/);

  // 8) Alterar o rascunho NÃO muda o que o cliente recebe.
  definition = updateStep(definition, welcome.id, (step) => ({ ...step, text: "Olá! Nova saudação da versão 2." }) as EditorStep);
  const edited = await owner.action(editorPath, saveId, {
    flowId: flow.id,
    expectedRevision: "2",
    snapshot: snapshotOf("Atendimento do Sítio (fictício)", true, definition),
  });
  assert.match(edited.text, /Rascunho salvo/);
  const second = customer("+5511955559102");
  const beforeV2 = (await second("Oi")).text;
  assert.match(beforeV2, /Bem-vindo ao Sítio Exemplo/);
  assert.doesNotMatch(beforeV2, /Nova saudação/);
  assert.match((await owner.page(editorPath)).html, /Rascunho salvo, não publicado/);

  // 9) Publicar a versão 2: conversa nova usa a nova.
  assert.match((await owner.action(editorPath, publishId, { flowId: flow.id, expectedRevision: "3" })).text, /Versão 2 publicada/);
  assert.match((await customer("+5511955559103")("Oi")).text, /Nova saudação da versão 2/);

  // 10) Histórico: ver e restaurar a versão 1 (vira rascunho; nada é publicado).
  const history = await owner.page(`${editorPath}/versoes`);
  assert.match(history.html, /Versão 2/);
  assert.match(history.html, /Versão 1/);
  assert.match(history.html, /Em uso/);
  const v1Page = await owner.page(`${editorPath}/versoes/1`);
  assert.match(v1Page.html, /Bem-vindo ao Sítio Exemplo/);
  assert.match(v1Page.html, /Fazer uma reserva/);
  const restoreId = actionIdIn(v1Page.html, 'name="version"');
  const restored = await owner.action(`${editorPath}/versoes/1`, restoreId, { flowId: flow.id, version: "1", expectedRevision: "3" });
  assert.match(restored.redirect ?? "", /restaurada=1/);
  const afterRestore = await flowRow(flow.id);
  assert.equal(afterRestore.draft_revision, 4);
  assert.equal(afterRestore.draft_definition.steps[0].text, "Olá! Bem-vindo ao Sítio Exemplo.");
  assert.equal(await versionCount(flow.id), 2, "restaurar não publica");
  const v2 = await row("SELECT definition FROM public.automation_flow_versions WHERE flow_id = $1 AND version = 2", [flow.id]);
  assert.equal(v2.definition.steps[0].text, "Olá! Nova saudação da versão 2.", "versão 2 intacta");
  assert.match((await owner.page(`${editorPath}?restaurada=1`)).html, /O conteúdo da versão 1 foi carregado como rascunho/);
  assert.match((await owner.action(editorPath, publishId, { flowId: flow.id, expectedRevision: "4" })).text, /Versão 3 publicada/);

  // Revisão velha (outra aba, outra pessoa): conflito, nada gravado.
  const stale = await owner.action(editorPath, saveId, { flowId: flow.id, expectedRevision: "2", snapshot: v1Snapshot });
  assert.match(stale.text, /Outra pessoa salvou alterações/);
  assert.equal((await flowRow(flow.id)).draft_revision, 4);

  // Pausar e reativar pela lista.
  const statusId = actionIdIn((await owner.page("/fluxos")).html, 'value="paused"');
  assert.match((await owner.action("/fluxos", statusId, { flowId: flow.id, status: "paused" })).text, /Automação pausada/);
  assert.equal((await flowRow(flow.id)).status, "paused");
  // Pausada: o editor avisa que a prévia continua valendo e o indicador de entrada não promete resposta.
  const paused = (await owner.page(editorPath)).html;
  assert.match(paused, /Automação pausada: as conversas novas não recebem respostas automáticas/);
  assert.match(paused, /a prévia roda só na memória e não\s+envia mensagens reais/);
  assert.match(paused, /Pausada: não responde às conversas novas/);
  assert.doesNotMatch(paused, /Responde às conversas novas/);
  assert.match((await owner.page("/fluxos")).html, /Pausada: não responde às conversas novas/);
  assert.match((await owner.action("/fluxos", statusId, { flowId: flow.id, status: "active" })).text, /Automação reativada/);
  assert.equal((await flowRow(flow.id)).status, "active");
  const active = (await owner.page(editorPath)).html;
  assert.doesNotMatch(active, /Automação pausada: as conversas novas/);
  assert.match(active, /Responde às conversas novas/);
});

test("sem permissão: atendente, outra organização e organização manipulada não alteram automações nem imagens", async () => {
  const owner = await login("aOwner");
  const attendant = await login("aAttendant");
  const bOwner = await login("bOwner");
  const flow = await row("SELECT id, draft_revision FROM public.automation_flows WHERE organization_id = $1", [f.orgA]);
  const editorPath = `/fluxos/${flow.id}`;
  const editor = await owner.page(editorPath);
  const saveId = actionIdIn(editor.html, 'name="snapshot"');
  const publishId = actionIdIn(editor.html, "Publicar versão");
  const statusId = actionIdIn((await owner.page("/fluxos")).html, 'value="paused"');
  const createId = actionIdIn((await owner.page("/fluxos/novo")).html, 'name="name"');
  const restoreId = actionIdIn((await owner.page(`${editorPath}/versoes/1`)).html, 'name="version"');
  const snapshot = snapshotOf("Invadido", false, toEditorDefinition((await flowRow(flow.id)).draft_definition)!);
  const before = await flowRow(flow.id);
  const versions = await versionCount(flow.id);

  // Atendente: vê a lista, não o editor, e as ações são recusadas.
  assert.match((await attendant.page("/fluxos")).html, /Atendimento do Sítio/);
  assert.match((await attendant.page(editorPath)).html, /Só proprietários e administradores editam automações/);
  assert.equal((await attendant.page("/fluxos/novo")).redirect, "/fluxos");
  const adminOnly = /Só proprietários e administradores podem alterar automações/;
  assert.match((await attendant.action(editorPath, saveId, { flowId: flow.id, expectedRevision: String(before.draft_revision), snapshot })).text, adminOnly);
  assert.match((await attendant.action(editorPath, publishId, { flowId: flow.id, expectedRevision: String(before.draft_revision) })).text, adminOnly);
  assert.match((await attendant.action("/fluxos", statusId, { flowId: flow.id, status: "paused" })).text, adminOnly);
  assert.match((await attendant.action("/fluxos/novo", createId, { name: "Do atendente" })).text, adminOnly);
  assert.match((await attendant.action(editorPath, restoreId, { flowId: flow.id, version: "1", expectedRevision: String(before.draft_revision) })).text, adminOnly);

  // Owner de B (com Automações): o fluxo de A não existe para ele.
  for (const path of [editorPath, `${editorPath}/versoes`, `${editorPath}/versoes/1`]) {
    const page = await bOwner.page(path);
    assert.match(page.html, /Automação não encontrada/, path);
    assert.doesNotMatch(page.html, /Atendimento do Sítio|Bem-vindo ao Sítio/, path);
  }
  const notFound = /Automação não encontrada/;
  assert.match((await bOwner.action(editorPath, saveId, { flowId: flow.id, expectedRevision: String(before.draft_revision), snapshot })).text, notFound);
  assert.match((await bOwner.action(editorPath, publishId, { flowId: flow.id, expectedRevision: String(before.draft_revision) })).text, notFound);
  assert.match((await bOwner.action("/fluxos", statusId, { flowId: flow.id, status: "paused" })).text, notFound);
  assert.match((await bOwner.action(editorPath, restoreId, { flowId: flow.id, version: "1", expectedRevision: String(before.draft_revision) })).text, notFound);
  // Campos extras (organização, autor) no formulário são ignorados: nada muda para A.
  await bOwner.action("/fluxos/novo", createId, { name: "Criado por B", organizationId: f.orgA, isEntry: "on" });
  assert.equal((await row("SELECT count(*)::int AS n FROM public.automation_flows WHERE organization_id = $1", [f.orgA])).n, 1);
  assert.equal((await row("SELECT count(*)::int AS n FROM public.automation_flows WHERE organization_id = $1 AND name = 'Criado por B'", [f.orgB])).n, 1);

  const afterAll = await flowRow(flow.id);
  assert.deepEqual(
    [afterAll.draft_revision, afterAll.status, afterAll.published_version_id],
    [before.draft_revision, before.status, before.published_version_id],
  );
  assert.equal(await versionCount(flow.id), versions);

  // Imagens: só membros da organização dona, com o módulo; sem sessão, login.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("e2e-imagem")]);
  const { mediaId } = await uploadFlowImage({ userId: f.users.aOwner, organizationId: f.orgA }, { fileName: "cardapio.jpg", data: jpeg });
  const image = await owner.raw(`/fluxos/imagens/${mediaId}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.match(image.headers.get("cache-control") ?? "", /^private/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal((await bOwner.raw(`/fluxos/imagens/${mediaId}`)).status, 404);
  assert.equal((await owner.raw("/fluxos/imagens/nao-e-uuid")).status, 404);
  const anonymous = await fetch(`${BASE}/fluxos/imagens/${mediaId}`, { redirect: "manual", headers: { "x-forwarded-for": uniqueIp() } });
  assert.equal(anonymous.status, 307);
  assert.match(anonymous.headers.get("location") ?? "", /\/login/);
});

test("publicar por POST direto: imagem de outra organização é recusada; a própria é aceita", async () => {
  const owner = await login("aOwner");
  const flow = await row("SELECT id, name, is_entry FROM public.automation_flows WHERE organization_id = $1 AND name LIKE 'Atendimento do Sítio%'", [f.orgA]);
  const editorPath = `/fluxos/${flow.id}`;
  const editor = await owner.page(editorPath);
  const saveId = actionIdIn(editor.html, 'name="snapshot"');
  const publishId = actionIdIn(editor.html, "Publicar versão");

  const jpeg = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(label)]);
  const foreign = await uploadFlowImage({ userId: f.users.bOwner, organizationId: f.orgB }, { fileName: "de-b.jpg", data: jpeg("e2e-b") });
  const mine = await uploadFlowImage({ userId: f.users.aOwner, organizationId: f.orgA }, { fileName: "de-a.jpg", data: jpeg("e2e-a") });

  const withImage = async (mediaId: string) => {
    const current = await flowRow(flow.id);
    const definition = toEditorDefinition(current.draft_definition)!;
    const edited = updateStep(
      definition,
      definition.steps[0].id,
      (step) => ({ id: step.id, name: step.name, type: "image", mediaId, next: (step as { next: string }).next }) as EditorStep,
    );
    const saved = await owner.action(editorPath, saveId, {
      flowId: flow.id,
      expectedRevision: String(current.draft_revision),
      snapshot: snapshotOf(flow.name, flow.is_entry, edited),
    });
    assert.match(saved.text, /Rascunho salvo/);
    return (await flowRow(flow.id)).draft_revision as number;
  };
  const versions = await versionCount(flow.id);
  const unavailable = /não está disponível para a sua organização/;

  const badRevision = await withImage(foreign.mediaId);
  const refused = await owner.action(editorPath, publishId, { flowId: flow.id, expectedRevision: String(badRevision) });
  assert.match(refused.text, unavailable);
  assert.ok(!refused.text.includes(foreign.mediaId), "a resposta não repete o id da imagem de outra organização");
  assert.equal(await versionCount(flow.id), versions);

  const goodRevision = await withImage(mine.mediaId);
  assert.match((await owner.action(editorPath, publishId, { flowId: flow.id, expectedRevision: String(goodRevision) })).text, /Versão \d+ publicada/);
  assert.equal(await versionCount(flow.id), versions + 1);
});
