/**
 * Entrega E3A — atendimento automatizado ponta a ponta contra a aplicação
 * Next.js REAL (`pnpm app:e2e`: `next dev` isolado sobre o banco de TESTES).
 * Cenário obrigatório: organização com Automações → fluxo publicado (ferramenta
 * de desenvolvimento do simulador) → cliente simulado inicia a conversa →
 * boas-vindas e menu → escolhas e coleta → encaminhamento para a Inbox →
 * atendente vê os dados coletados, assume e responde. Tudo por HTTP, como o
 * navegador; o banco é conferido pelo dono das tabelas.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

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

/** Navegador mínimo (mesmo protocolo de tests/e2e/attendance.test.ts). */
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
    const html = response.status === 200 ? await response.text() : "";
    const streamed = /NEXT_REDIRECT;(?:replace|push);([^;]+);/.exec(html)?.[1];
    const location = response.headers.get("location");
    return { status: response.status, redirect: location ? new URL(location, BASE).pathname : (streamed ?? null), html };
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
    return { status: response.status, text: await response.text() };
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

before(async () => {
  assert.ok(BASE?.startsWith("http://127.0.0.1:"), "use `pnpm app:e2e`");
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  await fixture.query("INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'automacoes', true)", [
    f.orgA,
  ]);
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  for (const who of ["aOwner", "aAttendant", "bOwner"] as Who[]) {
    const result = await provisioner.provision({ email: emailOf(who), name: who, rotatePassword: true });
    passwords.set(who, result.password as string);
  }
});

after(async () => {
  // Sessões referenciam versões: conversas (e sessões) antes dos fluxos.
  await fixture.query("DELETE FROM public.messages WHERE organization_id = $1", [f.orgA]);
  await fixture.query("DELETE FROM public.conversations WHERE organization_id = $1", [f.orgA]);
  await fixture.query("DELETE FROM public.automation_flows WHERE organization_id = $1", [f.orgA]);
  await dropFixtures(fixture, f);
  await fixture.end();
  await identity.close();
});

test("atendimento automatizado completo pelo navegador: fluxo publicado → menu → coleta → Inbox → atendente assume e responde", async () => {
  const owner = await login("aOwner");
  const attendant = await login("aAttendant");
  const phone = "+5511955558001";

  // 1–2) Owner publica o fluxo demonstrativo pela ferramenta de desenvolvimento.
  const simulator = await owner.page(`/simulador?canal=${f.accountA}`);
  assert.match(simulator.html, /Automação \(dev\)/);
  assert.match(simulator.html, /Sem fluxo de entrada/);
  const installId = actionIdIn(simulator.html, "Instalar fluxo demonstrativo");
  const installed = await owner.action("/simulador", installId, { channelId: f.accountA });
  assert.match(installed.text, /Fluxo demonstrativo publicado em Org A Integração \(versão 1\)/);
  assert.match((await attendant.page("/fluxos")).html, /Atendimento de entrada \(demonstração\)/);

  // 3–6) Cliente inicia a conversa: boas-vindas com imagem e menu.
  const simulateId = actionIdIn((await owner.page(`/simulador?canal=${f.accountA}`)).html, 'name="phoneNumber"');
  const send = (content: string) =>
    owner.action("/simulador", simulateId, { channelId: f.accountA, phoneNumber: phone, contactName: "Cliente Automação", content, repeatExternalId: "" });
  const welcome = await send("Olá!");
  assert.match(welcome.text, /Automação respondeu — 2 mensagem\(ns\) simulada\(s\)/);
  assert.match(welcome.text, /Como podemos ajudar\?/);
  const conversation = await row(
    "SELECT c.id, c.status FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.organization_id = $1 AND ct.phone_number = $2",
    [f.orgA, phone],
  );
  assert.equal(conversation.status, "bot");

  // 7–9) Escolhas, resposta inválida e coleta.
  assert.match((await send("banana")).text, /Não entendi sua resposta/);
  assert.match((await send("Reservas")).text, /Qual experiência você quer reservar\?/);
  assert.match((await send("2")).text, /qual é o seu nome\?/);
  await send("Maria E2E");
  const handoff = await send("6");
  assert.match(handoff.text, /Automação encaminhou a conversa para a equipe/);

  // 10) Conversa na Inbox, aguardando, com os dados coletados.
  const path = `/conversas/${conversation.id}`;
  const detail = await attendant.page(path);
  assert.match(detail.html, /Aguardando atendimento/);
  assert.match(detail.html, /Dados coletados pela automação/);
  assert.match(detail.html, /Maria E2E/);
  assert.match(detail.html, /Encaminhada para a equipe/);
  assert.match(detail.html, /menu de opções/);
  assert.match(detail.html, /A automação passou a conversa para a equipe/);

  // 11) Atendente assume e responde normalmente.
  const statusId = actionIdIn(detail.html, 'value="claim"');
  assert.match((await attendant.action(path, statusId, { conversationId: conversation.id, operation: "claim" })).text, /Você assumiu o atendimento/);
  const replyId = actionIdIn((await attendant.page(path)).html, 'name="clientMessageId"');
  const reply = await attendant.action(path, replyId, {
    conversationId: conversation.id,
    clientMessageId: randomUUID(),
    content: "Olá Maria, vamos confirmar sua reserva.",
  });
  assert.match(reply.text, /Mensagem enviada \(simulação/);

  // O robô não responde mais; o histórico distingue automação e atendente.
  assert.match((await send("Obrigada!")).text, /a conversa está com a equipe; o robô não responde/);
  const senders = await row(
    `SELECT array_agg(sender_type::text || ':' || (sender_user_id IS NULL)::text ORDER BY created_at, id) FILTER (WHERE direction = 'outbound') AS outbound
     FROM public.messages WHERE conversation_id = $1`,
    [conversation.id],
  );
  assert.ok(senders.outbound.slice(0, -1).every((value: string) => value === "bot:true"), JSON.stringify(senders.outbound));
  assert.equal(senders.outbound.at(-1), "user:false");
  const events = await row(
    "SELECT array_agg(event_type::text ORDER BY created_at, id) AS types FROM public.conversation_events WHERE conversation_id = $1",
    [conversation.id],
  );
  assert.deepEqual(events.types, ["automation_started", "handed_off", "assigned"]);
});

test("ferramenta do fluxo e Automações: atendente não instala, e organização sem o módulo não acessa", async () => {
  const owner = await login("aOwner");
  const attendant = await login("aAttendant");
  const bOwner = await login("bOwner");
  const installId = actionIdIn((await owner.page(`/simulador?canal=${f.accountA}`)).html, "fluxo demonstrativo");
  const denied = await attendant.action("/simulador", installId, { channelId: f.accountA });
  assert.match(denied.text, /Canal não encontrado entre os seus/);
  const foreign = await bOwner.action("/simulador", installId, { channelId: f.accountA });
  assert.match(foreign.text, /Canal não encontrado entre os seus/);
  assert.equal((await bOwner.page("/fluxos")).redirect, "/modulo-indisponivel?modulo=automacoes");
  const flows = await row("SELECT count(*)::int AS n FROM public.automation_flows WHERE organization_id = $1", [f.orgB]);
  assert.equal(flows.n, 0);
});

test("rajada pelo simulador: três respostas enviadas quase juntas são todas processadas, na ordem de gravação", async () => {
  const owner = await login("aOwner");
  const phone = "+5511955558002";
  const simulateId = actionIdIn((await owner.page(`/simulador?canal=${f.accountA}`)).html, 'name="phoneNumber"');
  const send = (content: string) =>
    owner.action("/simulador", simulateId, { channelId: f.accountA, phoneNumber: phone, contactName: "Cliente Rajada", content, repeatExternalId: "" });
  await send("Oi");
  await send("Eventos particulares"); // pergunta o nome

  const burst = ["Ana Rajada", "60", "15/12"];
  const responses = await Promise.all(
    burst.map((content, index) => new Promise((resolve) => setTimeout(resolve, index * 15)).then(() => send(content))),
  );
  for (const response of responses) assert.equal(response.status, 200);

  const conversation = await row(
    "SELECT c.id FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.organization_id = $1 AND ct.phone_number = $2",
    [f.orgA, phone],
  );
  const arrival = (
    await fixture.query(
      "SELECT content FROM public.messages WHERE conversation_id = $1 AND content = ANY($2::text[]) ORDER BY arrival_order",
      [conversation.id, burst],
    )
  ).rows.map((message) => message.content);
  const session = await row("SELECT status, state -> 'answers' AS answers FROM public.automation_sessions WHERE conversation_id = $1", [conversation.id]);
  assert.equal(session.status, "handed_off");
  assert.deepEqual(
    session.answers.map((answer: { value: string }) => answer.value),
    arrival,
    "cada resposta na pergunta seguinte, na ordem em que foram gravadas",
  );
  const pending = await row(
    `SELECT count(*)::int AS n FROM public.messages m WHERE m.conversation_id = $1 AND m.direction = 'inbound'
       AND NOT EXISTS (SELECT 1 FROM public.automation_executions e WHERE e.message_id = m.id)`,
    [conversation.id],
  );
  assert.equal(pending.n, 0, "nenhuma mensagem válida ficou sem processar");
  const duplicated = await row(
    "SELECT count(*)::int AS n FROM public.messages WHERE conversation_id = $1 AND sender_type = 'bot' AND content IN ('Quantos convidados, aproximadamente?', 'Qual a data desejada?')",
    [conversation.id],
  );
  assert.equal(duplicated.n, 2, "cada pergunta enviada uma única vez");
});
