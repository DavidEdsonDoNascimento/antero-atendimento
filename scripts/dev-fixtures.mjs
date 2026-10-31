#!/usr/bin/env node
// Fixtures FICTÍCIAS do banco de DESENVOLVIMENTO local, para validar a
// aplicação no navegador (Entrega 5B). Use via `pnpm db:dev-fixtures`: o
// scripts/infra.mjs monta o ambiente (antero_auth e antero_migrator do banco
// de desenvolvimento, origem local, Mailpit). Ver docs/INFRA-LOCAL.md.
//
//   --rotate-passwords   define novas senhas para as identidades fictícias
//                        (encerra as sessões delas) e as exibe uma vez
//
// Garantias:
//   - recusa qualquer alvo que não seja o banco de desenvolvimento local
//     (loopback, nome esperado, sem `_test`);
//   - idempotente e sem sobrescrever: ids determinísticos + `ON CONFLICT DO
//     NOTHING`; uma organização com o mesmo slug e outro id aborta tudo;
//   - identidades criadas pelo fluxo oficial do Better Auth (provisionamento
//     local, sem cadastro público); senhas geradas, exibidas UMA vez e nunca
//     gravadas;
//   - só dados inventados: nomes "(fictício)", e-mails `@ficticio.local`,
//     telefones +55 11 9xxxx do intervalo reservado abaixo.

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import pg from "pg";

import { parseIdentityConfig } from "../src/lib/identity/config.ts";
import { createIdentityPool } from "../src/lib/identity/pool.ts";
import { createLocalProvisioner } from "../src/lib/identity/provision.ts";

const { values } = parseArgs({ options: { "rotate-passwords": { type: "boolean", default: false } } });

function fail(message) {
  console.error(`[dev-fixtures] ERRO: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Alvo: só o banco de desenvolvimento local
// ---------------------------------------------------------------------------

const fixtureUrl = new URL(process.env.DEV_FIXTURE_URL ?? "postgres://invalido");
const expectedDatabase = process.env.DEV_EXPECTED_DATABASE ?? "";
const expectedPort = process.env.DEV_EXPECTED_PORT ?? "";
const loopback = (host) => host === "127.0.0.1" || host === "localhost";
if (
  decodeURIComponent(fixtureUrl.username) !== "antero_migrator" ||
  !loopback(fixtureUrl.hostname) ||
  fixtureUrl.port !== expectedPort ||
  fixtureUrl.pathname.slice(1) !== expectedDatabase ||
  !expectedDatabase ||
  expectedDatabase.endsWith("_test")
) {
  fail("alvo inesperado — use `pnpm db:dev-fixtures` (só o banco de desenvolvimento local).");
}

const config = parseIdentityConfig(process.env);
if (config.database.database !== expectedDatabase || String(config.database.port) !== expectedPort) {
  fail("a identidade não aponta para o banco de desenvolvimento local.");
}

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

/** UUID determinístico (formato v5) para cada chave de fixture. */
function fixtureId(key) {
  const hex = createHash("sha256").update(`antero-dev-fixture:${key}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const ORGS = {
  A: { id: fixtureId("org:A"), name: "Clínica Aurora (fictícia)", slug: "ficticia-clinica-aurora" },
  B: { id: fixtureId("org:B"), name: "Oficina Boreal (fictícia)", slug: "ficticia-oficina-boreal" },
};

const ACCOUNTS = {
  A: { id: fixtureId("wa:A"), org: "A", display: "Aurora — atendimento (dev)", phone: "+5511900001000" },
  B: { id: fixtureId("wa:B"), org: "B", display: "Boreal — oficina (dev)", phone: "+5511900002000" },
};

// key → identidade + vínculos (org, papel, status, data do vínculo)
const USERS = {
  donoA: { email: "dono.a@ficticio.local", name: "Ana Dono (fictícia)", members: [["A", "owner", "active", "2026-10-01"]] },
  atendenteA: {
    email: "atendente.a@ficticio.local",
    name: "Bruno Atendente (fictício)",
    members: [["A", "attendant", "active", "2026-10-02"]],
  },
  adminPlataforma: {
    email: "admin.plataforma@ficticio.local",
    name: "Paula Plataforma (fictícia)",
    platformAdmin: true,
    members: [["A", "admin", "active", "2026-10-02"]],
  },
  desativadoA: {
    email: "desativado.a@ficticio.local",
    name: "Diego Desativado (fictício)",
    // Atendeu conversas e depois foi desativado.
    members: [["A", "attendant", "disabled", "2026-10-03"]],
  },
  recuperacaoA: {
    email: "recuperacao.a@ficticio.local",
    name: "Rita Recuperação (fictícia)",
    members: [["A", "attendant", "active", "2026-10-04"]],
  },
  donoB: { email: "dono.b@ficticio.local", name: "Beatriz Dono B (fictícia)", members: [["B", "owner", "active", "2026-10-01"]] },
  multi: {
    email: "multi@ficticio.local",
    name: "Marcos Multi (fictício)",
    // Vínculo com B é o mais antigo: a organização ativa (regra do MVP) é B.
    members: [
      ["B", "attendant", "active", "2026-10-01"],
      ["A", "attendant", "active", "2026-10-05"],
    ],
  },
  semOrganizacao: { email: "sem.organizacao@ficticio.local", name: "Sofia Sem Org (fictícia)", members: [] },
};

const BASE = Date.parse("2026-10-20T15:00:00Z");
/** Instante determinístico com microssegundos (string aceita pelo PostgreSQL). */
function at(minutesBefore, micros = 0) {
  const ms = BASE - minutesBefore * 60_000;
  const iso = new Date(ms).toISOString().replace("Z", "");
  return `${iso.slice(0, 19)}.${String(Number(iso.slice(20, 23)) * 1000 + micros).padStart(6, "0")}+00`;
}

const STATUSES = ["waiting", "human", "bot", "resolved", "waiting", "human"];
const INBOUND = ["Olá, bom dia!", "Gostaria de agendar um horário.", "Qual o valor da consulta?", "Obrigado pelo retorno."];
const OUTBOUND = ["Olá! Como podemos ajudar?", "Temos horários na quinta-feira.", "Vou verificar e já retorno.", "Disponha!"];

/** Conversas e mensagens fictícias. `assignee` = chave em USERS. */
function buildConversations() {
  const conversations = [];

  // A: histórico longo (3 páginas de 100), a mais recente da lista.
  const longMessages = [];
  for (let i = 0; i < 230; i += 1) {
    const inbound = i % 2 === 0;
    longMessages.push({
      key: `long:${i}`,
      inbound,
      sender: inbound ? null : "atendenteA",
      content: `${inbound ? "Cliente" : "Atendente"}: mensagem ${String(i + 1).padStart(3, "0")} do histórico longo`,
      at: at(230 - i - 60, i % 7),
    });
  }
  conversations.push({
    key: "A:long",
    org: "A",
    contact: { key: "A:long", name: "Helena Histórico (fictícia)", phone: "+5511910000901" },
    status: "human",
    assignee: "atendenteA",
    started: at(400),
    messages: longMessages,
  });

  // A: sem mensagens.
  conversations.push({
    key: "A:empty",
    org: "A",
    contact: { key: "A:empty", name: "Vitor Vazio (fictício)", phone: "+5511910000902" },
    status: "waiting",
    started: at(75),
    messages: [],
  });

  // A: atribuída ao atendente depois desativado.
  conversations.push({
    key: "A:disabled",
    org: "A",
    contact: { key: "A:disabled", name: "Otávio Órfão (fictício)", phone: "+5511910000903" },
    status: "human",
    assignee: "desativadoA",
    started: at(300),
    messages: [
      { key: "disabled:1", inbound: true, content: "Preciso remarcar.", at: at(290, 11) },
      { key: "disabled:2", inbound: false, sender: "desativadoA", content: "Claro, para quando?", at: at(285, 12) },
    ],
  });

  // A: 42 conversas comuns (com as 3 acima, 45 → 3 páginas de 20).
  for (let n = 1; n <= 42; n += 1) {
    const status = STATUSES[n % STATUSES.length];
    const assignee = status === "human" ? (n % 4 === 1 ? "donoA" : "atendenteA") : null;
    const last = 100 + n * 37;
    const count = 2 + (n % 3);
    const messages = [];
    for (let m = 0; m < count; m += 1) {
      const inbound = m % 2 === 0;
      messages.push({
        key: `A:${n}:${m}`,
        inbound,
        sender: inbound ? null : (assignee ?? null),
        bot: !inbound && !assignee,
        content: inbound ? INBOUND[(n + m) % INBOUND.length] : OUTBOUND[(n + m) % OUTBOUND.length],
        at: at(last + (count - 1 - m) * 3, n),
      });
    }
    conversations.push({
      key: `A:${n}`,
      org: "A",
      contact: { key: `A:${n}`, name: `Cliente Aurora ${String(n).padStart(2, "0")} (fictício)`, phone: `+55119100001${String(n).padStart(2, "0")}` },
      status,
      assignee,
      started: at(last + 30),
      messages,
    });
  }

  // B: 6 conversas — nunca podem aparecer para quem está em A.
  for (let n = 1; n <= 6; n += 1) {
    const last = 50 + n * 41;
    conversations.push({
      key: `B:${n}`,
      org: "B",
      contact: { key: `B:${n}`, name: `Cliente Boreal ${String(n).padStart(2, "0")} (fictício)`, phone: `+55119200002${String(n).padStart(2, "0")}` },
      status: n % 2 ? "waiting" : "human",
      assignee: n % 2 ? null : "donoB",
      started: at(last + 20),
      messages: [
        { key: `B:${n}:0`, inbound: true, content: "Meu carro está fazendo um barulho.", at: at(last + 5, n) },
        { key: `B:${n}:1`, inbound: false, bot: true, content: "Recebemos sua mensagem (boreal).", at: at(last, n) },
      ],
    });
  }
  return conversations;
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const authPool = createIdentityPool(config.database);
const client = new pg.Client({ connectionString: fixtureUrl.toString(), application_name: "antero-dev-fixtures" });
const identities = {};

try {
  await client.connect();
  const { rows: who } = await client.query(
    "SELECT current_database() AS db, current_user AS role, (SELECT count(*) FROM pg_extension WHERE extname = 'pgtap')::int AS pgtap",
  );
  if (who[0].db !== expectedDatabase || who[0].role !== "antero_owner" || who[0].pgtap !== 0) {
    fail("o servidor não é o banco de desenvolvimento esperado. Nada foi alterado.");
  }

  // Nenhum dado preexistente é sobrescrito: slug ocupado por outra organização → aborta.
  for (const org of Object.values(ORGS)) {
    const { rows } = await client.query("SELECT id FROM public.organizations WHERE slug = $1", [org.slug]);
    if (rows[0] && rows[0].id !== org.id) {
      fail(`já existe outra organização com o slug ${org.slug}. Nada foi alterado.`);
    }
  }

  // 1) Identidades pelo fluxo oficial do Better Auth (antero_auth).
  const provisioner = createLocalProvisioner({ config, pool: authPool });
  for (const [key, user] of Object.entries(USERS)) {
    const result = await provisioner.provision({
      email: user.email,
      name: user.name,
      rotatePassword: values["rotate-passwords"],
    });
    identities[key] = result;
  }

  // 2) Dados de negócio numa transação (antero_migrator → dono das tabelas).
  const conversations = buildConversations();
  await client.query("BEGIN");
  for (const org of Object.values(ORGS)) {
    await client.query(
      "INSERT INTO public.organizations (id, name, slug, status, created_at) VALUES ($1, $2, $3, 'active', '2026-09-30 12:00:00+00') ON CONFLICT (id) DO NOTHING",
      [org.id, org.name, org.slug],
    );
    // Organização nova nasce sem módulos; estas usam a Inbox. Não sobrescreve o
    // que o admin da plataforma tiver configurado.
    await client.query(
      "INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'atendimento', true) ON CONFLICT (organization_id, module) DO NOTHING",
      [org.id],
    );
  }
  for (const account of Object.values(ACCOUNTS)) {
    await client.query(
      `INSERT INTO public.whatsapp_accounts (id, organization_id, provider, status, display_name, phone_number, created_at)
       VALUES ($1, $2, 'development', 'connected', $3, $4, '2026-09-30 12:00:00+00') ON CONFLICT (id) DO NOTHING`,
      [account.id, ORGS[account.org].id, account.display, account.phone],
    );
  }
  for (const [key, user] of Object.entries(USERS)) {
    const userId = identities[key].userId;
    for (const [org, role, status, since] of user.members) {
      await client.query(
        `INSERT INTO public.organization_members (organization_id, user_id, role, status, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [ORGS[org].id, userId, role, status, `${since} 12:00:00+00`],
      );
    }
    if (user.platformAdmin) {
      await client.query("UPDATE public.profiles SET is_platform_admin = true WHERE id = $1 AND NOT is_platform_admin", [userId]);
    }
  }
  let inserted = 0;
  for (const c of conversations) {
    const orgId = ORGS[c.org].id;
    const accountId = ACCOUNTS[c.org].id;
    const contactId = fixtureId(`contact:${c.contact.key}`);
    const conversationId = fixtureId(`conversation:${c.key}`);
    const last = c.messages.length ? c.messages.reduce((a, m) => (m.at > a ? m.at : a), c.messages[0].at) : c.started;
    const assigneeId = c.assignee ? identities[c.assignee].userId : null;
    await client.query(
      "INSERT INTO public.contacts (id, organization_id, phone_number, name, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
      [contactId, orgId, c.contact.phone, c.contact.name, c.started],
    );
    const result = await client.query(
      `INSERT INTO public.conversations
         (id, organization_id, whatsapp_account_id, contact_id, status, assigned_user_id, assigned_at,
          started_at, last_message_at, resolved_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $8) ON CONFLICT (id) DO NOTHING`,
      [
        conversationId,
        orgId,
        accountId,
        contactId,
        c.status,
        assigneeId,
        assigneeId ? c.started : null,
        c.started,
        last,
        c.status === "resolved" ? last : null,
      ],
    );
    inserted += result.rowCount;
    for (const m of c.messages) {
      const senderType = m.inbound ? "contact" : m.sender ? "user" : m.bot ? "bot" : "system";
      await client.query(
        `INSERT INTO public.messages
           (id, organization_id, conversation_id, whatsapp_account_id, direction, sender_type, sender_user_id,
            content, delivery_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [
          fixtureId(`message:${m.key}`),
          orgId,
          conversationId,
          accountId,
          m.inbound ? "inbound" : "outbound",
          senderType,
          m.sender ? identities[m.sender].userId : null,
          m.content,
          m.inbound ? "delivered" : "read",
          m.at,
        ],
      );
    }
  }
  await client.query("COMMIT");

  const { rows: totals } = await client.query(
    `SELECT o.slug,
            (SELECT count(*) FROM public.conversations c WHERE c.organization_id = o.id)::int AS conversations,
            (SELECT count(*) FROM public.messages m WHERE m.organization_id = o.id)::int AS messages
     FROM public.organizations o WHERE o.id = ANY($1::uuid[]) ORDER BY o.slug`,
    [Object.values(ORGS).map((org) => org.id)],
  );
  console.log(`[dev-fixtures] banco ${expectedDatabase}:${expectedPort} — conversas novas nesta execução: ${inserted}`);
  for (const row of totals) console.log(`  ${row.slug}: ${row.conversations} conversas, ${row.messages} mensagens`);
  console.log("[dev-fixtures] identidades fictícias (senha só quando criada/rotacionada agora; não é gravada):");
  for (const [key, user] of Object.entries(USERS)) {
    const { password, created } = identities[key];
    const memberships = user.members.map(([org, role, status]) => `${org}:${role}${status === "active" ? "" : `(${status})`}`).join(", ") || "sem organização";
    console.log(
      `  ${user.email.padEnd(34)} ${memberships}${user.platformAdmin ? " +admin-plataforma" : ""}` +
        `${password ? `  senha: ${password}` : created ? "" : "  (senha mantida)"}`,
    );
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`[dev-fixtures] ${error instanceof Error ? `${error.name}: ${error.message}` : "falha"}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  await authPool.end();
}
