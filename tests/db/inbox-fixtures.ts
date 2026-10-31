/**
 * Fixtures determinísticas da Inbox (Entrega 4) sobre as fixtures base de
 * harness.ts, com TODOS os timestamps explícitos:
 *
 * Org A (9 conversas, ordem esperada por last_message_at DESC, id DESC):
 *   cA  waiting   15:00:00          (conversa base de harness.ts)
 *   c1  human     14:00:00.000002   atendente aAttendant; 2 mensagens EMPATADAS no último instante
 *   c2  human     13:00:00.000001   atendente aOwner        ┐ empate exato em last_message_at
 *   c3  waiting   13:00:00.000001   mensagem longa (trecho) ┘ (desempate por id)
 *   c4  bot       13:00:00          1 µs antes de c2/c3; contato sem nome
 *   c5  resolved  12:00:00          atribuída a aDisabled (perfil oculto pela RLS)
 *   c6  waiting   11:00:00          SEM mensagens
 *   c7  bot       10:00:00          mesmo contato de c1, pelo 2º canal (sem nome de exibição)
 *   cH  waiting   09:00:00.000004   histórico: 7 mensagens com empates e passos de 1 µs
 * Org B: conversa base + cB2 (mesmo instante de c2/c3, para provar que empates não cruzam empresas).
 * Org C: sem conta, sem conversas (lista vazia).
 *
 * Usuários extras: multi (atendente ativo em A e em B; vínculo em B mais
 * antigo), cOwner (dono de C), platformAdmin (sem organização).
 */
import type pg from "pg";

import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import { createExtraUsers, createFixtures, dropFixtures, type Fixtures } from "./harness.ts";

/** Instante de 2026-03-10 em UTC, no formato aceito pelo PostgreSQL. */
export const at = (time: string) => `2026-03-10 ${time}+00`;
/** O mesmo instante no formato ISO devolvido pela camada (igual ao to_json). */
export const iso = (time: string) => `2026-03-10T${time}+00:00`;

export type InboxFixtures = Fixtures & {
  orgC: string;
  accountA2: string;
  more: { multi: string; cOwner: string; platformAdmin: string };
  conv: Record<"cA" | "c1" | "c2" | "c3" | "c4" | "c5" | "c6" | "c7" | "cH" | "cB2", string>;
  contactsA: string[];
  c1TieMessageIds: string[];
  /** Mensagens de cH em ordem cronológica (created_at, id). */
  historyIds: string[];
};

export const LONG_CONTENT = `${"Mensagem longa ".repeat(12)}🙂 fim`;

export async function createInboxFixtures(fixture: pg.Client): Promise<InboxFixtures> {
  const f = await createFixtures(fixture);
  const more = await createExtraUsers(f.suffix, {
    multi: "Multi Org",
    cOwner: "C Owner",
    platformAdmin: "Admin Plataforma",
  });
  const one = async (sql: string, values: unknown[]) => (await fixture.query(sql, values)).rows[0].id as string;

  await fixture.query("UPDATE public.profiles SET is_platform_admin = true WHERE id = $1", [more.platformAdmin]);
  const orgC = await one("INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    "Org C Vazia",
    `org-c-${f.suffix}`,
  ]);
  await fixture.query("INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'atendimento', true)", [
    orgC,
  ]);
  await fixture.query(
    `INSERT INTO public.organization_members (organization_id, user_id, role, status, created_at) VALUES
       ($1, $4, 'attendant', 'active', '2026-02-01 00:00:00+00'),
       ($2, $4, 'attendant', 'active', '2026-01-01 00:00:00+00'),
       ($3, $5, 'owner', 'active', '2026-01-01 00:00:00+00')`,
    [f.orgA, f.orgB, orgC, more.multi, more.cOwner],
  );

  // Canais de A: o 2º é o MAIS ANTIGO (a conta "principal" é a de menor created_at).
  await fixture.query("UPDATE public.whatsapp_accounts SET created_at = '2026-01-05 00:00:00+00' WHERE id = $1", [
    f.accountA,
  ]);
  const accountA2 = await one(
    `INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, phone_number, created_at)
     VALUES ($1, 'development', 'connected', NULL, '+5511900000002', '2026-01-01 00:00:00+00') RETURNING id`,
    [f.orgA],
  );

  const contact = (org: string, phone: string, name: string | null) =>
    one("INSERT INTO public.contacts (organization_id, phone_number, name) VALUES ($1, $2, $3) RETURNING id", [
      org,
      phone,
      name,
    ]);
  const k1 = await contact(f.orgA, "+5511955550101", "Ana");
  const k2 = await contact(f.orgA, "+5511955550102", "Bruno");
  const k3 = await contact(f.orgA, "+5511955550103", "Carla");
  const k4 = await contact(f.orgA, "+5511955550104", null);
  const k5 = await contact(f.orgA, "+5511955550105", "Edu");
  const k6 = await contact(f.orgA, "+5511955550106", "Fabi");
  const kH = await contact(f.orgA, "+5511955550107", "Histórico");
  const kB2 = await contact(f.orgB, "+5511955550201", "Contato B2");

  type ConversationSpec = {
    org?: string;
    account?: string;
    contact: string;
    status: "bot" | "waiting" | "human" | "resolved";
    assignee?: string;
    started: string;
    last: string;
    resolvedAt?: string;
  };
  const conversation = (spec: ConversationSpec) =>
    one(
      `INSERT INTO public.conversations
         (organization_id, whatsapp_account_id, contact_id, status, assigned_user_id, assigned_at,
          started_at, last_message_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        spec.org ?? f.orgA,
        spec.account ?? f.accountA,
        spec.contact,
        spec.status,
        spec.assignee ?? null,
        spec.assignee ? spec.started : null,
        spec.started,
        spec.last,
        spec.resolvedAt ?? null,
      ],
    );

  type MessageSpec = {
    direction: "inbound" | "outbound";
    sender: "contact" | "bot" | "user" | "system";
    user?: string;
    content: string;
    at: string;
    delivery?: "pending" | "sent" | "delivered" | "read" | "failed";
  };
  const message = (conv: string, spec: MessageSpec, account = f.accountA, org = f.orgA) =>
    one(
      `INSERT INTO public.messages
         (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, sender_user_id,
          content, created_at, delivery_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [org, conv, account, spec.direction, spec.sender, spec.user ?? null, spec.content, spec.at, spec.delivery ?? "sent"],
    );
  const inbound = (content: string, time: string): MessageSpec => ({
    direction: "inbound",
    sender: "contact",
    content,
    at: at(time),
  });

  // Conversa base de A, com timestamps fixos.
  await fixture.query("UPDATE public.conversations SET started_at = $2, last_message_at = $3 WHERE id = $1", [
    f.conversationA,
    at("14:50:00"),
    at("15:00:00"),
  ]);
  await fixture.query("UPDATE public.messages SET created_at = $2 WHERE conversation_id = $1", [
    f.conversationA,
    at("15:00:00"),
  ]);

  const c1 = await conversation({
    contact: k1,
    status: "human",
    assignee: f.users.aAttendant,
    started: at("13:00:00"),
    last: at("14:00:00.000002"),
  });
  await message(c1, inbound("oi c1", "13:59:00"));
  const c1TieMessageIds = [
    await message(c1, {
      direction: "outbound",
      sender: "user",
      user: f.users.aAttendant,
      content: "resposta A",
      at: at("14:00:00.000002"),
      delivery: "delivered",
    }),
    await message(c1, {
      direction: "outbound",
      sender: "user",
      user: f.users.aAttendant,
      content: "resposta B",
      at: at("14:00:00.000002"),
      delivery: "read",
    }),
  ];

  const c2 = await conversation({
    contact: k2,
    status: "human",
    assignee: f.users.aOwner,
    started: at("12:00:00"),
    last: at("13:00:00.000001"),
  });
  await message(c2, inbound("c2 última", "13:00:00.000001"));

  const c3 = await conversation({ contact: k3, status: "waiting", started: at("12:00:00"), last: at("13:00:00.000001") });
  await message(c3, inbound("c3 antiga", "12:59:00"));
  await message(c3, inbound(LONG_CONTENT, "13:00:00.000001"));

  const c4 = await conversation({ contact: k4, status: "bot", started: at("12:00:00"), last: at("13:00:00") });
  await message(c4, { direction: "outbound", sender: "bot", content: "c4 bot", at: at("13:00:00") });

  const c5 = await conversation({
    contact: k5,
    status: "resolved",
    assignee: f.users.aDisabled,
    started: at("10:30:00"),
    last: at("12:00:00"),
    resolvedAt: at("12:30:00"),
  });
  await message(c5, inbound("c5 pergunta", "11:00:00"));
  await message(c5, {
    direction: "outbound",
    sender: "user",
    user: f.users.aDisabled,
    content: "c5 última",
    at: at("12:00:00"),
  });

  const c6 = await conversation({ contact: k6, status: "waiting", started: at("11:00:00"), last: at("11:00:00") });

  const c7 = await conversation({
    account: accountA2,
    contact: k1,
    status: "bot",
    started: at("09:30:00"),
    last: at("10:00:00"),
  });
  await message(c7, inbound("c7 pelo canal 2", "10:00:00"), accountA2);

  const cH = await conversation({ contact: kH, status: "waiting", started: at("08:00:00"), last: at("09:00:00.000004") });
  await message(cH, inbound("h1", "09:00:00"));
  await message(cH, { direction: "outbound", sender: "bot", content: "h2 bot", at: at("09:00:00.000001") });
  await message(cH, {
    direction: "outbound",
    sender: "user",
    user: f.users.aOwner,
    content: "h3 dono",
    at: at("09:00:00.000001"),
    delivery: "read",
  });
  await message(cH, inbound("h4", "09:00:00.000002"));
  await message(cH, { direction: "outbound", sender: "system", content: "h5 sistema", at: at("09:00:00.000002") });
  await message(cH, inbound("h6", "09:00:00.000003"));
  await message(cH, {
    direction: "outbound",
    sender: "user",
    user: f.users.aAttendant,
    content: "h7 atendente",
    at: at("09:00:00.000004"),
    delivery: "failed",
  });
  const historyIds = (
    await fixture.query("SELECT id FROM public.messages WHERE conversation_id = $1 ORDER BY created_at, id", [cH])
  ).rows.map((row) => row.id as string);

  const cB2 = await conversation({
    org: f.orgB,
    account: f.accountB,
    contact: kB2,
    status: "waiting",
    started: at("12:00:00"),
    last: at("13:00:00.000001"),
  });
  await message(cB2, inbound("mensagem B2", "13:00:00.000001"), f.accountB, f.orgB);

  return {
    ...f,
    orgC,
    accountA2,
    more,
    conv: { cA: f.conversationA, c1, c2, c3, c4, c5, c6, c7, cH, cB2 },
    contactsA: [f.contactA, k1, k2, k3, k4, k5, k6, kH],
    c1TieMessageIds,
    historyIds,
  };
}

export async function dropInboxFixtures(fixture: pg.Client, f: InboxFixtures): Promise<void> {
  await fixture.query("DELETE FROM public.organizations WHERE id = $1", [f.orgC]);
  await dropFixtures(fixture, f);
  await fixture.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [Object.values(f.more)]);
}

/** Ids da organização na ordem da Inbox, calculados pelo dono das tabelas (sem RLS). */
export async function referenceConversationOrder(
  fixture: pg.Client,
  organizationId: string,
  status?: string,
): Promise<string[]> {
  const filter = status === "open" ? "AND status <> 'resolved'" : status ? "AND status = $2::public.conversation_status" : "";
  const { rows } = await fixture.query(
    `SELECT id FROM public.conversations WHERE organization_id = $1 ${filter} ORDER BY last_message_at DESC, id DESC`,
    status && status !== "open" ? [organizationId, status] : [organizationId],
  );
  return rows.map((row) => row.id as string);
}

// ---------------------------------------------------------------------------
// Referência PostgREST: o JSON que o PostgREST montava para os `select` de
// modules/conversations/queries.ts — subconsultas json_build_object/json_agg
// pelas mesmas FKs, executadas SOB A RLS do usuário (o PostgREST roda tudo
// com o papel da sessão), inclusive `last_message` ordenado só por
// `created_at DESC` com `limit 1`, como em queries.ts. Independente do SQL
// de sql.ts: serve de contrato para comparar os resultados mapeados.
// ---------------------------------------------------------------------------

const REFERENCE_EMBEDS = `
  'id', c.id, 'status', c.status, 'started_at', c.started_at, 'last_message_at', c.last_message_at,
  'contact', (SELECT json_build_object('id', ct.id, 'name', ct.name, 'phone_number', ct.phone_number)
              FROM public.contacts ct WHERE ct.organization_id = c.organization_id AND ct.id = c.contact_id),
  'whatsapp_account', (SELECT json_build_object('id', wa.id, 'display_name', wa.display_name, 'phone_number', wa.phone_number)
                       FROM public.whatsapp_accounts wa
                       WHERE wa.organization_id = c.organization_id AND wa.id = c.whatsapp_account_id),
  'assigned_member', (SELECT json_build_object(
                         'user_id', om.user_id,
                         'profile', (SELECT json_build_object('id', p.id, 'full_name', p.full_name)
                                     FROM public.profiles p WHERE p.id = om.user_id))
                      FROM public.organization_members om
                      WHERE om.organization_id = c.organization_id AND om.user_id = c.assigned_user_id)`;

const REFERENCE_LIST_SQL = `
SELECT json_build_object(${REFERENCE_EMBEDS},
  'last_message', coalesce((
    SELECT json_agg(lm) FROM (
      SELECT m.id, m.direction, m.sender_type, m.content, m.created_at
      FROM public.messages m
      WHERE m.organization_id = c.organization_id AND m.conversation_id = c.id
        AND m.whatsapp_account_id = c.whatsapp_account_id
      ORDER BY m.created_at DESC
      LIMIT 1) lm), '[]'::json)
) AS row
FROM public.conversations c
WHERE c.organization_id = $1
ORDER BY c.last_message_at DESC, c.id DESC`;

const REFERENCE_DETAIL_SQL = `
SELECT json_build_object(${REFERENCE_EMBEDS}, 'assigned_at', c.assigned_at, 'resolved_at', c.resolved_at) AS row
FROM public.conversations c
WHERE c.organization_id = $1 AND c.id = $2`;

/** Linhas cruas no formato PostgREST (rows.ts), vistas por `userId` sob RLS. */
export async function postgrestReferenceList<T>(userId: string, organizationId: string): Promise<T[]> {
  return withUserTransaction(userId, async (tx) =>
    (await tx.query<{ row: T }>(REFERENCE_LIST_SQL, [organizationId])).rows.map((r) => r.row),
  );
}

export async function postgrestReferenceDetail<T>(
  userId: string,
  organizationId: string,
  conversationId: string,
): Promise<T | null> {
  return withUserTransaction(userId, async (tx) => {
    const { rows } = await tx.query<{ row: T }>(REFERENCE_DETAIL_SQL, [organizationId, conversationId]);
    return rows[0]?.row ?? null;
  });
}
