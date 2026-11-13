/**
 * Entrega E3A — motor de automações pela camada da aplicação, com o pool
 * `antero_app` (sem BYPASSRLS): ingestão real do simulador → executor
 * (`runDevAutomation`: prepare → motor → commit → provedor simulado) →
 * encaminhamento → atendente assume e responde. O dono das tabelas só monta
 * cenários e confere o que ficou gravado. Concorrência com conexões reais.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError, ModuleDisabledError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import type { OutboundAction } from "../../src/modules/automations/actions.ts";
import { AutomationUnavailableError, runDevAutomation, type AutomationRunResult } from "../../src/modules/automations/runner.ts";
import { FlowCommandError, publishFlow, saveFlowDraft, setFlowStatus } from "../../src/modules/automations/sql-commands.ts";
import { getConversationAutomation, listFlows } from "../../src/modules/automations/sql-queries.ts";
import { claimConversation, sendConversationReply } from "../../src/modules/conversations/sql-commands.ts";
import { listConversationMessages } from "../../src/modules/conversations/sql-queries.ts";
import type { MessagingProvider } from "../../src/modules/messaging/provider.ts";
import { DEMO_FLOW_DEFINITION } from "../../src/modules/simulator/demo-flow.ts";
import { simulateInboundMessage } from "../../src/modules/simulator/sql-queries.ts";
import { connectFixtureClient, createFixtures, dropFixtures, type Fixtures } from "./harness.ts";

let fixture: pg.Client;
let f: Fixtures;
let flowA: string;

const ctx = (userId: string, organizationId = f.orgA) => ({ userId, organizationId });
const owner = () => ctx(f.users.aOwner);
const attendant = () => ctx(f.users.aAttendant);
const row = async (sql: string, values: unknown[]) => (await fixture.query(sql, values)).rows[0];

let phoneSeq = 0;
const newPhone = () => `+55119888${String(++phoneSeq).padStart(5, "0")}`;

/** Cliente envia uma mensagem pelo simulador (ingestão real). */
async function inbound(phone: string, content: string, options: { externalId?: string; userId?: string; channelId?: string } = {}) {
  return simulateInboundMessage(
    { userId: options.userId ?? f.users.aOwner },
    {
      channelId: options.channelId ?? f.accountA,
      phoneNumber: phone,
      contactName: "Cliente Simulado",
      content,
      externalMessageId: options.externalId ?? `sim-in-${randomUUID()}`,
    },
  );
}

/** Mensagem do cliente + automação, como a Server Action do simulador faz. */
async function say(phone: string, content: string, userId = f.users.aOwner, channelId = f.accountA) {
  const message = await inbound(phone, content, { userId, channelId });
  const run = await runDevAutomation({ userId }, message.message_id);
  return { message, run, conversationId: message.conversation_id };
}

function active(run: AutomationRunResult) {
  assert.notEqual(run.action, "none", JSON.stringify(run));
  return run as Extract<AutomationRunResult, { action: "start" | "advance" }>;
}

const replyTypes = (run: AutomationRunResult) => active(run).replies.map((reply: OutboundAction) => reply.type);
const conversationStatus = async (id: string) => (await row("SELECT status FROM public.conversations WHERE id = $1", [id])).status;
const botMessages = async (id: string) =>
  Number((await row("SELECT count(*) FROM public.messages WHERE conversation_id = $1 AND sender_type = 'bot'", [id])).count);

before(async () => {
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  await fixture.query(
    "INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'automacoes', true), ($2, 'automacoes', true)",
    [f.orgA, f.orgB],
  );
  const saved = await saveFlowDraft(owner(), { slug: "entrada", name: "Entrada", definition: DEMO_FLOW_DEFINITION, isEntry: true });
  flowA = saved.flowId;
  await publishFlow(owner(), flowA);
});

after(async () => {
  // Sessões referenciam versões: conversas (e sessões) antes dos fluxos.
  for (const org of [f.orgA, f.orgB]) {
    await fixture.query("DELETE FROM public.messages WHERE organization_id = $1", [org]);
    await fixture.query("DELETE FROM public.conversations WHERE organization_id = $1", [org]);
    await fixture.query("DELETE FROM public.automation_flows WHERE organization_id = $1", [org]);
  }
  await dropFixtures(fixture, f);
  await fixture.end();
  await closeAppPool();
});

test("configuração: valida a definição antes de gravar; papel e módulo conferidos", async () => {
  await assert.rejects(
    saveFlowDraft(owner(), { slug: "quebrado", name: "Quebrado", definition: { schemaVersion: 1, entryStepId: "x", steps: [] }, isEntry: false }),
    (error: unknown) => error instanceof FlowCommandError && error.code === "invalid_definition" && error.issues.length > 0,
  );
  await assert.rejects(
    saveFlowDraft(attendant(), { slug: "outro", name: "Outro", definition: DEMO_FLOW_DEFINITION, isEntry: false }),
    (error: unknown) => error instanceof FlowCommandError && error.code === "access_denied",
  );
  await assert.rejects(
    saveFlowDraft(owner(), { slug: "segunda-entrada", name: "Segunda", definition: DEMO_FLOW_DEFINITION, isEntry: true }),
    (error: unknown) => error instanceof FlowCommandError && error.code === "entry_conflict",
  );
  await assert.rejects(
    saveFlowDraft(ctx(f.users.aOwner, f.orgB), { slug: "x", name: "X", definition: DEMO_FLOW_DEFINITION, isEntry: false }),
    AccessDeniedError,
  );
  const flows = await listFlows(attendant());
  assert.deepEqual(flows.map((flow) => [flow.slug, flow.status, flow.publishedVersion, flow.isEntry]), [["entrada", "active", 1, true]]);
});

test("atendimento automatizado completo: boas-vindas, menu, reserva com coleta, encaminhamento e atendente responde", async () => {
  const phone = newPhone();
  const start = await say(phone, "Olá!");
  assert.equal(active(start.run).action, "start");
  assert.deepEqual(replyTypes(start.run), ["image", "list"]);
  assert.equal(active(start.run).sent, 2);
  assert.equal(await conversationStatus(start.conversationId), "bot");

  assert.deepEqual(replyTypes((await say(phone, "1")).run), ["list"]);
  assert.deepEqual(replyTypes((await say(phone, "Café da tarde")).run), ["text", "text"]);
  await say(phone, "Maria Exemplo");
  const done = await say(phone, "4");
  assert.equal(active(done.run).status, "handed_off");
  assert.equal(active(done.run).reason, "handoff_step");

  const conversationId = start.conversationId;
  assert.equal(await conversationStatus(conversationId), "waiting");
  const pending = await row(
    "SELECT count(*) FILTER (WHERE delivery_status <> 'sent') AS not_sent, count(*) AS total FROM public.messages WHERE conversation_id = $1 AND sender_type = 'bot'",
    [conversationId],
  );
  assert.equal(Number(pending.not_sent), 0, "todas as respostas do robô ficaram como enviadas (simuladas)");
  const external = await row(
    "SELECT bool_and(external_message_id LIKE 'sim-out-%') AS simulated FROM public.messages WHERE conversation_id = $1 AND sender_type = 'bot'",
    [conversationId],
  );
  assert.equal(external.simulated, true, "id externo simulado, nunca um wamid da Meta");

  // Depois do encaminhamento, o robô não volta a responder.
  const after = await say(phone, "Alô?");
  assert.deepEqual(after.run, { action: "none", reason: "not_eligible" });

  // Atendente vê os dados coletados, na ordem, assume e responde normalmente.
  const automation = await getConversationAutomation(attendant(), conversationId);
  assert.equal(automation?.status, "handed_off");
  assert.equal(automation?.flowName, "Entrada");
  assert.deepEqual(
    automation?.answers.map((answer) => [answer.label, answer.value]),
    [["Nome", "Maria Exemplo"], ["Pessoas", "4"]],
  );
  assert.equal((await claimConversation(attendant(), conversationId)).changed, true);
  const reply = await sendConversationReply(attendant(), {
    conversationId,
    content: "Olá Maria! Sua pré-reserva foi recebida.",
    clientMessageId: randomUUID(),
  });
  assert.equal(reply.deliveryStatus, "sent");

  const history = await listConversationMessages(attendant(), conversationId, { limit: 100 });
  const senders = history!.items.map((item) => item.sender);
  assert.equal(senders.at(-1), "user");
  assert.ok(senders.includes("bot"));
  assert.equal(
    history!.items.filter((item) => item.sender === "bot").every((item) => item.senderUserId === null),
    true,
    "mensagens automáticas não são atribuídas a ninguém",
  );
  const types = history!.items.filter((item) => item.sender === "bot").map((item) => item.messageType);
  assert.deepEqual(types.slice(0, 2), ["image", "interactive"]);
});

test("mensagem duplicada (reentrega) não avança a sessão nem envia de novo", async () => {
  const phone = newPhone();
  await say(phone, "Oi");
  const externalId = `sim-in-${randomUUID()}`;
  const first = await inbound(phone, "4", { externalId });
  const run = await runDevAutomation({ userId: f.users.aOwner }, first.message_id);
  assert.deepEqual(replyTypes(run), ["list"]);
  const count = await botMessages(first.conversation_id);

  const again = await inbound(phone, "4", { externalId });
  assert.equal(again.duplicate, true);
  assert.equal(again.message_id, first.message_id);
  assert.deepEqual(await runDevAutomation({ userId: f.users.aOwner }, again.message_id), { action: "none", reason: "already_processed" });
  assert.equal(await botMessages(first.conversation_id), count);
});

test("concorrência: a mesma mensagem processada em paralelo executa uma vez só", async () => {
  const phone = newPhone();
  const message = await inbound(phone, "Oi");
  const runs = await Promise.all(Array.from({ length: 4 }, () => runDevAutomation({ userId: f.users.aOwner }, message.message_id)));
  assert.equal(runs.filter((run) => run.action === "start").length, 1, JSON.stringify(runs));
  assert.equal(await botMessages(message.conversation_id), 2);
  const executions = await row("SELECT count(*) FROM public.automation_executions WHERE message_id = $1", [message.message_id]);
  assert.equal(Number(executions.count), 1);
});

test("concorrência: ingestões e execuções simultâneas na mesma conversa processam as duas, na ordem de gravação", async () => {
  const phone = newPhone();
  const { conversationId } = await say(phone, "Oi");
  // Ingestões em paralelo: a ordem de gravação é decidida pela trava da conversa.
  const [a, b] = await Promise.all([inbound(phone, "1"), inbound(phone, "4")]);
  const runs = await Promise.all([a, b].map((message) => runDevAutomation({ userId: f.users.aOwner }, message.message_id)));
  for (const run of runs.filter((candidate) => candidate.action === "none")) {
    assert.equal(run.reason, "already_processed", "quem chega depois encontra a fila já processada");
  }
  const processed = runs.reduce((total, run) => total + (run.action === "none" ? 0 : run.processed), 0);
  assert.equal(processed, 2, JSON.stringify(runs));

  const order = (
    await fixture.query("SELECT content FROM public.messages WHERE id = ANY($1::uuid[]) ORDER BY arrival_order", [[a.message_id, b.message_id]])
  ).rows.map((message) => message.content);
  const session = await row(
    "SELECT revision, current_step_id, (SELECT count(*) FROM public.automation_executions e WHERE e.session_id = s.id) AS executions FROM public.automation_sessions s WHERE conversation_id = $1",
    [conversationId],
  );
  assert.equal(Number(session.executions), 3, "uma execução por mensagem");
  assert.equal(session.revision, 3, "a revisão avança uma vez por mensagem");
  // "1" e depois "4": Reservas → Alterar uma reserva. "4" e depois "1": Informações → Localização.
  assert.equal(session.current_step_id, order[0] === "1" ? "alterar-nome" : "menu-informacoes", `ordem gravada: ${order.join(", ")}`);
});

test("sessão sobrevive a reinício da aplicação (pool fechado e reaberto)", async () => {
  const phone = newPhone();
  const { conversationId } = await say(phone, "Oi");
  await say(phone, "2");
  await closeAppPool();
  const next = await say(phone, "Ana");
  assert.equal(active(next.run).action, "advance");
  const session = await row("SELECT current_step_id, state FROM public.automation_sessions WHERE conversation_id = $1", [conversationId]);
  assert.equal(session.current_step_id, "eventos-convidados");
  assert.deepEqual(session.state.answers, [{ key: "nome", label: "Nome", value: "Ana" }]);
});

test("versões: publicar de novo não muda a sessão em andamento; conversa nova usa a nova", async () => {
  const phone = newPhone();
  const old = await say(phone, "Oi");
  const changed = structuredClone(DEMO_FLOW_DEFINITION) as typeof DEMO_FLOW_DEFINITION;
  const menu = changed.steps.find((step) => step.id === "menu-principal");
  if (menu?.type === "menu") menu.text = "Versão nova do menu.";
  await saveFlowDraft(owner(), { slug: "entrada", name: "Entrada", definition: changed, isEntry: true });
  const published = await publishFlow(owner(), flowA);
  assert.equal(published.version, 2);

  const back = await say(phone, "5x"); // inválida: repete o menu da versão em que começou
  const list = active(back.run).replies.find((reply) => reply.type === "list");
  assert.equal(list?.type === "list" && list.body, "Como podemos ajudar? Escolha uma opção.");

  const fresh = await say(newPhone(), "Oi");
  const freshList = active(fresh.run).replies.find((reply) => reply.type === "list");
  assert.equal(freshList?.type === "list" && freshList.body, "Versão nova do menu.");
  const versions = await row(
    `SELECT array_agg(v.version ORDER BY v.version) AS versions FROM public.automation_sessions s
     JOIN public.automation_flow_versions v ON v.id = s.flow_version_id WHERE s.conversation_id IN ($1, $2)`,
    [old.conversationId, fresh.conversationId],
  );
  assert.deepEqual(versions.versions, [1, 2]);
});

test("pedido de atendente a qualquer momento encaminha, mesmo no meio da coleta", async () => {
  const phone = newPhone();
  const { conversationId } = await say(phone, "Oi");
  await say(phone, "3");
  const run = await say(phone, "atendente");
  assert.equal(active(run.run).status, "handed_off");
  assert.equal(active(run.run).reason, "human_requested");
  assert.equal(await conversationStatus(conversationId), "waiting");
});

test("atendente assume uma conversa em bot: o robô para", async () => {
  const phone = newPhone();
  const { conversationId } = await say(phone, "Oi");
  await claimConversation(attendant(), conversationId);
  const session = await row("SELECT status, end_reason FROM public.automation_sessions WHERE conversation_id = $1", [conversationId]);
  assert.deepEqual([session.status, session.end_reason], ["interrupted", "human_takeover"]);
  const before = await botMessages(conversationId);
  assert.deepEqual((await say(phone, "1")).run, { action: "none", reason: "not_eligible" });
  assert.equal(await botMessages(conversationId), before);
});

test("fluxo pausado e módulo desligado: a sessão para e nada é enviado", async () => {
  const phone = newPhone();
  const { conversationId } = await say(phone, "Oi");
  await setFlowStatus(owner(), flowA, "paused");
  try {
    assert.deepEqual((await say(phone, "1")).run, { action: "none", reason: "flow_paused" });
    assert.equal(await conversationStatus(conversationId), "waiting");
    assert.deepEqual((await say(newPhone(), "Oi")).run, { action: "none", reason: "no_flow" });
  } finally {
    await setFlowStatus(owner(), flowA, "active");
  }

  const other = newPhone();
  const second = await say(other, "Oi");
  await fixture.query("UPDATE public.organization_modules SET enabled = false WHERE organization_id = $1 AND module = 'automacoes'", [f.orgA]);
  try {
    assert.deepEqual((await say(other, "1")).run, { action: "none", reason: "module_disabled" });
    assert.equal(await conversationStatus(second.conversationId), "waiting");
    await assert.rejects(listFlows(owner()), ModuleDisabledError);
  } finally {
    await fixture.query("UPDATE public.organization_modules SET enabled = true WHERE organization_id = $1 AND module = 'automacoes'", [f.orgA]);
  }
});

test("sem o módulo Atendimento: nada de encaminhamento impossível; o fluxo avisa e continua", async () => {
  await fixture.query("UPDATE public.organization_modules SET enabled = false WHERE organization_id = $1 AND module = 'atendimento'", [f.orgB]);
  try {
    await withoutAttendance();
  } finally {
    await fixture.query("UPDATE public.organization_modules SET enabled = true WHERE organization_id = $1 AND module = 'atendimento'", [f.orgB]);
  }
});

async function withoutAttendance() {
  const ownerB = ctx(f.users.bOwner, f.orgB);
  const saved = await saveFlowDraft(ownerB, { slug: "entrada", name: "Entrada B", definition: DEMO_FLOW_DEFINITION, isEntry: true });
  await publishFlow(ownerB, saved.flowId);

  const phone = newPhone();
  const start = await say(phone, "atendente", f.users.bOwner, f.accountB);
  assert.deepEqual(replyTypes(start.run), ["image", "list"], "a saudação com 'atendente' apresenta o fluxo");
  const asked = await say(phone, "Falar com atendente", f.users.bOwner, f.accountB);
  assert.equal(active(asked.run).status, "active");
  const [notice] = active(asked.run).replies;
  assert.match(notice.type === "text" ? notice.text : "", /não temos atendimento humano/);
  assert.equal(await conversationStatus(start.conversationId), "bot");

  // Duas inválidas seguidas: sem equipe para receber, conclui e resolve.
  await say(phone, "banana", f.users.bOwner, f.accountB);
  const end = await say(phone, "banana", f.users.bOwner, f.accountB);
  assert.equal(active(end.run).status, "completed");
  assert.equal(await conversationStatus(start.conversationId), "resolved");

  // O cliente volta: reabre e a automação recomeça.
  const again = await say(phone, "Oi de novo", f.users.bOwner, f.accountB);
  assert.equal(active(again.run).action, "start");
}

test("falha no motor ou no provedor: sessão segura, conversa devolvida à equipe, mensagem preservada", async () => {
  const phone = newPhone();
  const message = await inbound(phone, "Oi");
  const run = await runDevAutomation({ userId: f.users.aOwner }, message.message_id, {
    engine: () => {
      throw new Error("falha simulada no motor");
    },
  });
  assert.equal(active(run).status, "failed");
  assert.equal(await conversationStatus(message.conversation_id), "waiting");
  assert.equal(await botMessages(message.conversation_id), 0);
  const kept = await row("SELECT content FROM public.messages WHERE id = $1", [message.message_id]);
  assert.equal(kept.content, "Oi", "a mensagem do cliente continua gravada");

  const refusing: MessagingProvider = {
    provider: "development",
    simulated: true,
    async sendText() {
      return { ok: false, reason: "recusado no teste" };
    },
    async send() {
      return { ok: false, reason: "recusado no teste" };
    },
  };
  const other = await inbound(newPhone(), "Oi");
  const delivered = active(await runDevAutomation({ userId: f.users.aOwner }, other.message_id, { providerFor: () => refusing }));
  assert.equal(delivered.status, "active");
  assert.equal(delivered.failedDeliveries, 2);
  const statuses = await row(
    "SELECT array_agg(delivery_status::text ORDER BY created_at) AS statuses FROM public.messages WHERE conversation_id = $1 AND sender_type = 'bot'",
    [other.conversation_id],
  );
  assert.deepEqual(statuses.statuses, ["failed", "failed"]);
});

test("isolamento: outra organização, atendente e organização suspensa não disparam a automação", async () => {
  const message = await inbound(newPhone(), "Oi");
  await assert.rejects(runDevAutomation({ userId: f.users.bOwner }, message.message_id), AccessDeniedError);
  await assert.rejects(runDevAutomation({ userId: f.users.aAttendant }, message.message_id), AccessDeniedError);
  await assert.rejects(runDevAutomation({ userId: f.users.nobody }, message.message_id), AccessDeniedError);
  assert.equal(await getConversationAutomation(ctx(f.users.bOwner, f.orgB), message.conversation_id), null);

  await fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [f.orgA]);
  try {
    await assert.rejects(runDevAutomation({ userId: f.users.aOwner }, message.message_id), AccessDeniedError);
  } finally {
    await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f.orgA]);
  }
  assert.equal(await botMessages(message.conversation_id), 0, "nada foi enviado");
});

test("fora de development/test o executor simulado recusa antes de tocar no banco", async () => {
  // NODE_ENV é somente leitura na tipagem do Next; em runtime é uma variável comum.
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    await assert.rejects(runDevAutomation({ userId: f.users.aOwner }, randomUUID()), AutomationUnavailableError);
  } finally {
    env.NODE_ENV = previous;
  }
});

// ---------------------------------------------------------------------------
// Mensagens em sequência rápida. O executor de cada mensagem roda depois da
// ingestão dela; o de uma mensagem mais nova pode obter a trava da conversa
// antes do da mais antiga. Os testes forçam essa ordem.
// ---------------------------------------------------------------------------

const answersOf = async (conversationId: string) =>
  (await row("SELECT state -> 'answers' AS answers, current_step_id, status FROM public.automation_sessions WHERE conversation_id = $1 ORDER BY started_at DESC LIMIT 1", [conversationId]));
const unprocessed = async (conversationId: string) =>
  Number(
    (
      await row(
        `SELECT count(*) FROM public.messages m
         WHERE m.conversation_id = $1 AND m.direction = 'inbound'
           AND NOT EXISTS (SELECT 1 FROM public.automation_executions e WHERE e.message_id = m.id)`,
        [conversationId],
      )
    ).count,
  );

test("rajada numa pergunta: a resposta mais nova processada primeiro não toma o lugar da mais antiga", async () => {
  const phone = newPhone();
  const { conversationId } = await say(phone, "Oi");
  await say(phone, "2"); // eventos → pergunta o nome
  const first = await inbound(phone, "Ana");
  const second = await inbound(phone, "80");
  await runDevAutomation({ userId: f.users.aOwner }, second.message_id);
  await runDevAutomation({ userId: f.users.aOwner }, first.message_id);
  const session = await answersOf(conversationId);
  assert.deepEqual(
    session.answers.map((answer: { key: string; value: string }) => [answer.key, answer.value]),
    [["nome", "Ana"], ["convidados", "80"]],
    "cada resposta na pergunta certa, na ordem de chegada",
  );
  assert.equal(session.current_step_id, "eventos-data");
  assert.equal(await unprocessed(conversationId), 0, "nenhuma mensagem válida ficou sem processar");
});

test("rajada na abertura: a segunda mensagem não se perde quando chega ao executor antes da primeira", async () => {
  const phone = newPhone();
  const first = await inbound(phone, "Oi");
  const second = await inbound(phone, "4"); // informações
  await runDevAutomation({ userId: f.users.aOwner }, second.message_id);
  await runDevAutomation({ userId: f.users.aOwner }, first.message_id);
  const session = await answersOf(first.conversation_id);
  assert.equal(session.current_step_id, "menu-informacoes");
  assert.equal(await unprocessed(first.conversation_id), 0);
});

test("rajada concorrente: três respostas seguidas, executores em paralelo, coleta íntegra e em ordem", async () => {
  const phone = newPhone();
  const { conversationId } = await say(phone, "Oi");
  await say(phone, "2");
  const burst = [];
  for (const content of ["Ana", "80", "20/12"]) burst.push(await inbound(phone, content));
  const runs = await Promise.all([...burst].reverse().map((message) => runDevAutomation({ userId: f.users.aOwner }, message.message_id)));
  assert.ok(runs.every((run) => run.action !== "none" || run.reason === "already_processed"), JSON.stringify(runs));
  const session = await answersOf(conversationId);
  assert.equal(session.status, "handed_off");
  assert.deepEqual(
    session.answers.map((answer: { value: string }) => answer.value),
    ["Ana", "80", "20/12"],
  );
  assert.equal(await unprocessed(conversationId), 0);
  const replies = await row(
    "SELECT count(*) FROM public.messages WHERE conversation_id = $1 AND sender_type = 'bot' AND content = 'Qual a data desejada?'",
    [conversationId],
  );
  assert.equal(Number(replies.count), 1, "nenhuma pergunta repetida ou duplicada");
});

// ---------------------------------------------------------------------------
// Desligar Automações ou suspender a organização impede respostas pendentes.
// ---------------------------------------------------------------------------

/** Provedor simulado que executa `onFirstSend` antes do primeiro envio (mudança "durante" o envio). */
function providerChangingStateOnFirstSend(onFirstSend: () => Promise<void>): { provider: MessagingProvider; sends: () => number } {
  let sends = 0;
  const provider: MessagingProvider = {
    provider: "development",
    simulated: true,
    async sendText() {
      return { ok: true, externalMessageId: `sim-out-${randomUUID()}` };
    },
    async send() {
      sends += 1;
      if (sends === 1) await onFirstSend();
      return { ok: true, externalMessageId: `sim-out-${randomUUID()}` };
    },
  };
  return { provider, sends: () => sends };
}

const botDeliveries = async (conversationId: string) =>
  (
    await fixture.query(
      "SELECT delivery_status::text AS status FROM public.messages WHERE conversation_id = $1 AND sender_type = 'bot' ORDER BY created_at, id",
      [conversationId],
    )
  ).rows.map((message) => message.status);

test("Automações desligado no meio do envio: a resposta seguinte não sai e nada novo é processado", async () => {
  const phone = newPhone();
  const message = await inbound(phone, "Oi");
  const disable = () =>
    fixture.query("UPDATE public.organization_modules SET enabled = false WHERE organization_id = $1 AND module = 'automacoes'", [f.orgA]).then(() => undefined);
  const { provider, sends } = providerChangingStateOnFirstSend(disable);
  try {
    const run = active(await runDevAutomation({ userId: f.users.aOwner }, message.message_id, { providerFor: () => provider }));
    assert.equal(sends(), 1, "só a primeira resposta chegou ao provedor");
    assert.equal(run.sent, 1);
    assert.equal(run.blockedDeliveries, 1);
    assert.deepEqual(await botDeliveries(message.conversation_id), ["sent", "failed"]);

    // Mensagens que chegarem depois não são respondidas; a sessão é interrompida.
    const next = await inbound(phone, "1");
    assert.deepEqual(await runDevAutomation({ userId: f.users.aOwner }, next.message_id), { action: "none", reason: "module_disabled" });
    assert.equal(await conversationStatus(message.conversation_id), "waiting");
    assert.equal((await botDeliveries(message.conversation_id)).length, 2, "nenhuma resposta nova");
  } finally {
    await fixture.query("UPDATE public.organization_modules SET enabled = true WHERE organization_id = $1 AND module = 'automacoes'", [f.orgA]);
  }
});

test("organização suspensa no meio do envio: nenhuma resposta pendente sai, nada é processado", async () => {
  const phone = newPhone();
  const message = await inbound(phone, "Oi");
  const suspend = () => fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [f.orgA]).then(() => undefined);
  const { provider, sends } = providerChangingStateOnFirstSend(suspend);
  try {
    const run = active(await runDevAutomation({ userId: f.users.aOwner }, message.message_id, { providerFor: () => provider }));
    assert.equal(sends(), 1, "depois da suspensão, nada mais chega ao provedor");
    assert.equal(run.blockedDeliveries, 1);
    // A 1ª saiu antes da suspensão, mas o resultado já não pôde ser gravado: fica `pending`
    // (limitação conhecida da fase 2; o reprocessamento é do worker, E2B). A 2ª nunca saiu.
    assert.deepEqual(await botDeliveries(message.conversation_id), ["pending", "pending"]);
    await assert.rejects(runDevAutomation({ userId: f.users.aOwner }, (await inbound(phone, "1").catch(() => message)).message_id), AccessDeniedError);
  } finally {
    await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f.orgA]);
  }
});

test("atendente assume entre o commit e o envio: a resposta do robô não sai", async () => {
  const message = await inbound(newPhone(), "Oi");
  const claim = () => claimConversation(attendant(), message.conversation_id).then(() => undefined);
  const { provider, sends } = providerChangingStateOnFirstSend(claim);
  const run = active(await runDevAutomation({ userId: f.users.aOwner }, message.message_id, { providerFor: () => provider }));
  assert.equal(sends(), 1);
  assert.equal(run.blockedDeliveries, 1);
  assert.deepEqual(await botDeliveries(message.conversation_id), ["sent", "failed"]);
  assert.equal(await conversationStatus(message.conversation_id), "human");
});
