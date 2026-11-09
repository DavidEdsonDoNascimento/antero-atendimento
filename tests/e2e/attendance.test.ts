/**
 * Entrega E2A — atendimento ponta a ponta contra a aplicação Next.js REAL
 * (`pnpm app:e2e`: `next dev` isolado sobre o banco de TESTES). Cenário
 * obrigatório: o simulador recebe a mensagem → a conversa aparece na Inbox → o
 * atendente assume, responde e resolve → nova mensagem reabre → histórico
 * íntegro → nada aparece para outra organização. Tudo por HTTP, como o
 * navegador: páginas com o cookie da sessão e Server Actions por POST (o id da
 * ação é lido do formulário renderizado). O banco é conferido pelo dono das
 * tabelas.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { createLocalProvisioner } from "../../src/lib/identity/provision.ts";
import { connectFixtureClient, createExtraUsers, createFixtures, dropFixtures, type Fixtures } from "../db/harness.ts";
import { createTestIdentity, uniqueIp, type TestIdentity } from "../db/identity-harness.ts";

const BASE = process.env.E2E_BASE_URL as string;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;

let identity: TestIdentity;
let fixture: pg.Client;
let f: Fixtures;
let extra: { att2: string };
const passwords = new Map<string, string>();

type Who = "aOwner" | "aAttendant" | "aDisabled" | "bOwner" | "att2";
const emailOf = (who: Who) =>
  ({
    aOwner: `a-owner.${f.suffix}@teste.local`,
    aAttendant: `a-attendant.${f.suffix}@teste.local`,
    aDisabled: `a-disabled.${f.suffix}@teste.local`,
    bOwner: `b-owner.${f.suffix}@teste.local`,
    att2: `att2.${f.suffix}@teste.local`,
  })[who];

/** Navegador mínimo: cookies, IP próprio (rate limit por IP), sem seguir redirecionamentos. */
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

  /** Server Action no formato que o React usa com `useActionState` (id no cabeçalho, campos no corpo). */
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

/** Id da Server Action do formulário que contém `marker` (o React o grava num campo oculto do form). */
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
const conversationOf = (phone: string) =>
  row(
    `SELECT c.id, c.status, c.assigned_user_id
     FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id
     WHERE ct.organization_id = $1 AND ct.phone_number = $2`,
    [f.orgA, phone],
  );

before(async () => {
  assert.ok(BASE?.startsWith("http://127.0.0.1:"), "use `pnpm app:e2e`");
  identity = createTestIdentity();
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  extra = await createExtraUsers(f.suffix, { att2: "Segundo Atendente" });
  await fixture.query("INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ($1, $2, 'attendant')", [
    f.orgA,
    extra.att2,
  ]);
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  for (const who of ["aOwner", "aAttendant", "aDisabled", "bOwner", "att2"] as Who[]) {
    const result = await provisioner.provision({ email: emailOf(who), name: who, rotatePassword: true });
    passwords.set(who, result.password as string);
  }
});

after(async () => {
  await dropFixtures(fixture, f);
  await fixture.query("DELETE FROM auth.users WHERE id = $1", [extra.att2]);
  await fixture.end();
  await identity.close();
});

test("cenário completo: simulador → Inbox → assumir → responder → resolver → reabrir, sem vazar para B", async () => {
  const owner = await login("aOwner");
  const attendant = await login("aAttendant");
  const other = await login("att2");
  const bOwner = await login("bOwner");
  const phone = "+5511955559001";

  // 1) Cliente simulado envia mensagem (owner de A no simulador).
  const simulator = await owner.page("/simulador");
  assert.equal(simulator.status, 200);
  assert.match(simulator.html, /Simulador de mensagens/);
  assert.match(simulator.html, new RegExp(`Canal A ${f.suffix}`));
  const simulateId = actionIdIn(simulator.html, 'name="channelId"');
  const sent = await owner.action("/simulador", simulateId, {
    channelId: f.accountA,
    phoneNumber: "+55 11 95555-9001",
    contactName: "Cliente E2E",
    content: "Olá, quero atendimento",
    repeatExternalId: "",
  });
  assert.equal(sent.status, 200);
  assert.match(sent.text, /Mensagem recebida pela Inbox/);
  const conversation = await conversationOf(phone);
  assert.equal(conversation.status, "waiting");

  // 2) A conversa aparece na Inbox de A — e não na de B.
  const inbox = await attendant.page("/conversas?status=waiting");
  assert.match(inbox.html, /Cliente E2E/);
  assert.doesNotMatch((await bOwner.page("/conversas")).html, /Cliente E2E/);
  assert.match((await bOwner.page(`/conversas/${conversation.id}`)).html, /Conversa não encontrada/);

  // 3) O atendente assume; o segundo atendente recebe conflito.
  const path = `/conversas/${conversation.id}`;
  const detail = await attendant.page(path);
  assert.match(detail.html, /Assumir atendimento/);
  assert.match(detail.html, /Canal de desenvolvimento: mensagens simuladas/);
  const statusId = actionIdIn(detail.html, 'value="claim"');
  const claim = await attendant.action(path, statusId, { conversationId: conversation.id, operation: "claim" });
  assert.match(claim.text, /Você assumiu o atendimento/);
  assert.equal((await conversationOf(phone)).assigned_user_id, f.users.aAttendant);
  const conflict = await other.action(path, statusId, { conversationId: conversation.id, operation: "claim" });
  assert.match(conflict.text, /Outro atendente já assumiu esta conversa/);
  assert.equal((await conversationOf(phone)).assigned_user_id, f.users.aAttendant);
  assert.match((await other.page(path)).html, /Esta conversa está com outro atendente/);

  // 4) O atendente responde; o mesmo envio repetido não duplica.
  const mine = await attendant.page(path);
  assert.match(mine.html, /Responsável:(?:<!-- -->| )*<span[^>]*>Você</);
  const replyId = actionIdIn(mine.html, 'name="clientMessageId"');
  const clientMessageId = randomUUID();
  const fields = { conversationId: conversation.id, clientMessageId, content: "Olá! Como posso ajudar?" };
  const reply = await attendant.action(path, replyId, fields);
  assert.match(reply.text, /Mensagem enviada \(simulação/);
  const again = await attendant.action(path, replyId, fields);
  assert.match(again.text, /já tinha sido enviada/);
  const outbound = await row(
    "SELECT count(*)::int AS n, min(delivery_status::text) AS status, min(external_message_id) AS external FROM public.messages WHERE conversation_id = $1 AND direction = 'outbound'",
    [conversation.id],
  );
  assert.equal(outbound.n, 1);
  assert.equal(outbound.status, "sent");
  assert.match(outbound.external, /^sim-out-/);

  // 5) A resposta aparece no histórico, identificada como simulada.
  const withReply = await attendant.page(path);
  assert.match(withReply.html, /Olá! Como posso ajudar\?/);
  assert.match(withReply.html, />simulada</);

  // Outro atendente não responde nem resolve a conversa de quem assumiu.
  const foreignReply = await other.action(path, replyId, { ...fields, clientMessageId: randomUUID(), content: "intruso" });
  assert.match(foreignReply.text, /Só o atendente responsável/);
  const foreignResolve = await other.action(path, statusId, { conversationId: conversation.id, operation: "resolve" });
  assert.match(foreignResolve.text, /Só o atendente responsável/);

  // 6) O atendente resolve.
  const resolve = await attendant.action(path, statusId, { conversationId: conversation.id, operation: "resolve" });
  assert.match(resolve.text, /Atendimento resolvido/);
  assert.equal((await conversationOf(phone)).status, "resolved");
  assert.match((await attendant.page(path)).html, /Uma nova mensagem do cliente reabre a conversa/);

  // 7–8) Nova mensagem do cliente reabre a conversa.
  const reopen = await owner.action("/simulador", simulateId, {
    channelId: f.accountA,
    phoneNumber: phone,
    contactName: "",
    content: "Voltei com outra dúvida",
    repeatExternalId: "",
  });
  assert.match(reopen.text, /conversa resolvida foi reaberta/);
  const reopened = await conversationOf(phone);
  assert.equal(reopened.status, "waiting");
  assert.equal(reopened.assigned_user_id, null);

  // 9) Histórico anterior íntegro, com o registro do atendimento.
  const history = await attendant.page(path);
  for (const text of ["Olá, quero atendimento", "Olá! Como posso ajudar?", "Voltei com outra dúvida"]) {
    assert.ok(history.html.includes(text), text);
  }
  assert.match(history.html, /Registro do atendimento \((?:<!-- -->)?3(?:<!-- -->)?\)/);
  assert.match(history.html, /Nova mensagem do cliente reabriu a conversa/);
  assert.match(history.html, /Assumir atendimento/);

  // 10) Nada disso chega a B.
  assert.doesNotMatch((await bOwner.page("/conversas")).html, /Cliente E2E|Voltei com outra dúvida/);
  const leaked = await row(
    "SELECT count(*)::int AS n FROM public.messages WHERE organization_id = $1 AND content LIKE 'Voltei%'",
    [f.orgB],
  );
  assert.equal(leaked.n, 0);
});

test("simulador: reentrega da mesma mensagem é duplicata; atendente e outra organização não simulam", async () => {
  const owner = await login("aOwner");
  const attendant = await login("aAttendant");
  const bOwner = await login("bOwner");
  const simulateId = actionIdIn((await owner.page("/simulador")).html, 'name="channelId"');
  const fields = {
    channelId: f.accountA,
    phoneNumber: "+5511955559002",
    contactName: "Duplicado",
    content: "mensagem única",
    repeatExternalId: `sim-in-${randomUUID()}`,
  };
  assert.match((await owner.action("/simulador", simulateId, fields)).text, /Mensagem recebida pela Inbox/);
  assert.match((await owner.action("/simulador", simulateId, fields)).text, /duplicata/);
  const stored = await row(
    "SELECT count(*)::int AS n FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.phone_number = $1",
    [fields.phoneNumber],
  );
  assert.equal(stored.n, 1);

  // Atendente: a página não lista canais e a ação é recusada no banco.
  assert.match((await attendant.page("/simulador")).html, /Nenhum canal disponível para simulação/);
  const denied = await attendant.action("/simulador", simulateId, { ...fields, phoneNumber: "+5511955559003", repeatExternalId: "" });
  assert.match(denied.text, /Só owner ou admin ativo/);
  // Owner de B mirando o canal de A.
  const foreign = await bOwner.action("/simulador", simulateId, { ...fields, phoneNumber: "+5511955559004", repeatExternalId: "" });
  assert.match(foreign.text, /Só owner ou admin ativo/);
  assert.doesNotMatch((await bOwner.page("/simulador")).html, new RegExp(`Canal A ${f.suffix}`));
  assert.equal(
    (await row("SELECT count(*)::int AS n FROM public.contacts WHERE phone_number IN ('+5511955559003', '+5511955559004')", [])).n,
    0,
  );

  // Sem sessão: o proxy manda para o login.
  const anonymous = await new Client().page("/simulador");
  assert.equal(anonymous.redirect, "/login");
});

test("organização suspensa, módulo desligado e vínculo desativado: ações sem efeito", async () => {
  const owner = await login("aOwner");
  const attendant = await login("aAttendant");
  const phone = "+5511955559005";
  const simulateId = actionIdIn((await owner.page("/simulador")).html, 'name="channelId"');
  await owner.action("/simulador", simulateId, { channelId: f.accountA, phoneNumber: phone, contactName: "", content: "oi", repeatExternalId: "" });
  const conversation = await conversationOf(phone);
  const path = `/conversas/${conversation.id}`;
  const statusId = actionIdIn((await attendant.page(path)).html, 'value="claim"');
  const claim = () => attendant.action(path, statusId, { conversationId: conversation.id, operation: "claim" });

  await fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [f.orgA]);
  try {
    await claim();
    assert.equal((await conversationOf(phone)).status, "waiting", "suspensa");
  } finally {
    await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f.orgA]);
  }

  await fixture.query("UPDATE public.organization_modules SET enabled = false WHERE organization_id = $1", [f.orgA]);
  try {
    await claim();
    assert.equal((await conversationOf(phone)).status, "waiting", "sem módulo");
    assert.equal((await attendant.page(path)).redirect, "/modulo-indisponivel?modulo=atendimento");
  } finally {
    await fixture.query("UPDATE public.organization_modules SET enabled = true WHERE organization_id = $1", [f.orgA]);
  }

  // Vínculo desativado depois do login: a sessão continua, a ação não.
  await fixture.query("UPDATE public.organization_members SET status = 'disabled' WHERE organization_id = $1 AND user_id = $2", [
    f.orgA,
    f.users.aAttendant,
  ]);
  try {
    await claim();
    assert.equal((await conversationOf(phone)).status, "waiting", "desativado");
  } finally {
    await fixture.query("UPDATE public.organization_members SET status = 'active' WHERE organization_id = $1 AND user_id = $2", [
      f.orgA,
      f.users.aAttendant,
    ]);
  }

  // Sem sessão.
  await new Client().action(path, statusId, { conversationId: conversation.id, operation: "claim" });
  assert.equal((await conversationOf(phone)).status, "waiting", "sem sessão");

  // Funciona de novo com tudo restaurado.
  assert.match((await claim()).text, /Você assumiu o atendimento/);
});

test("janela de 24 h encerrada: aviso na tela, campo desabilitado e envio recusado", async () => {
  const owner = await login("aOwner");
  const attendant = await login("aAttendant");
  const phone = "+5511955559006";
  const simulateId = actionIdIn((await owner.page("/simulador")).html, 'name="channelId"');
  await owner.action("/simulador", simulateId, { channelId: f.accountA, phoneNumber: phone, contactName: "", content: "oi", repeatExternalId: "" });
  const conversation = await conversationOf(phone);
  const path = `/conversas/${conversation.id}`;
  const statusId = actionIdIn((await attendant.page(path)).html, 'value="claim"');
  await attendant.action(path, statusId, { conversationId: conversation.id, operation: "claim" });
  const replyId = actionIdIn((await attendant.page(path)).html, 'name="clientMessageId"');

  await fixture.query("UPDATE public.messages SET created_at = now() - interval '25 hours' WHERE conversation_id = $1", [conversation.id]);
  const page = await attendant.page(path);
  assert.match(page.html, /A janela de 24 horas para respostas livres encerrou/);
  assert.match(page.html, /<textarea[^>]*disabled/);
  const refused = await attendant.action(path, replyId, { conversationId: conversation.id, clientMessageId: randomUUID(), content: "fora da janela" });
  assert.match(refused.text, /janela de 24 horas para respostas livres está encerrada/);
  assert.equal(
    (await row("SELECT count(*)::int AS n FROM public.messages WHERE conversation_id = $1 AND direction = 'outbound'", [conversation.id])).n,
    0,
  );
});
