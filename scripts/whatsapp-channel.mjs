#!/usr/bin/env node
// Cadastro CONTROLADO de um canal WhatsApp Cloud API numa organização (E2B-1).
// Ver docs/WHATSAPP.md. Localmente, use `pnpm whatsapp:channel <dev|test> -- …`
// (scripts/infra.mjs monta a conexão do alvo). Num servidor, rode este arquivo
// com WHATSAPP_CHANNEL_DATABASE_URL (papel antero_migrator) num --env-file.
//
//   --organization <uuid>         organização dona do número
//   --phone-number-id <dígitos>   Phone Number ID da Meta
//   --waba-id <dígitos>           WhatsApp Business Account ID da Meta
//   --display-phone <+E.164>      número exibido (opcional, informativo)
//   --display-name <texto>        nome do canal (opcional)
//   --status connected|disconnected   padrão: disconnected
//   --apply                       grava (sem ele, só simula e desfaz)
//
// Garantias:
//   - SIMULA por padrão: tudo roda numa transação que é desfeita no fim;
//     só `--apply` confirma;
//   - não apaga nada e não troca organização, número nem WABA de um canal
//     existente (o banco também recusa: 0014). Repetir o mesmo cadastro não
//     muda nada; só o status (connected/disconnected) pode ser alterado;
//   - recusa organização inexistente ou suspensa, Phone Number ID de outra
//     organização e WABA vinculada a outra organização;
//   - nenhum segredo: não recebe token da Meta nem imprime a conexão.
import { parseArgs } from "node:util";

import pg from "pg";

import { ChannelInputError, parseChannelInput } from "../src/modules/whatsapp/channel-input.ts";

const TAG = "[whatsapp-channel]";

function fail(message) {
  console.error(`${TAG} ERRO: ${message}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      organization: { type: "string" },
      "phone-number-id": { type: "string" },
      "waba-id": { type: "string" },
      "display-phone": { type: "string" },
      "display-name": { type: "string" },
      status: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  fail(`argumentos inválidos (${error.code ?? "erro"}). Veja o cabeçalho do script ou docs/WHATSAPP.md.`);
}

let input;
try {
  input = parseChannelInput(values);
} catch (error) {
  if (error instanceof ChannelInputError) fail(error.message);
  throw error;
}

const rawUrl = process.env.WHATSAPP_CHANNEL_DATABASE_URL ?? "";
let url;
try {
  url = new URL(rawUrl);
} catch {
  fail("WHATSAPP_CHANNEL_DATABASE_URL ausente ou inválida (papel antero_migrator).");
}
if (decodeURIComponent(url.username) !== "antero_migrator") {
  fail("WHATSAPP_CHANNEL_DATABASE_URL deve usar o papel antero_migrator (dono dos canais).");
}
const expectedDatabase = process.env.WHATSAPP_CHANNEL_EXPECTED_DATABASE ?? "";

const client = new pg.Client({ connectionString: rawUrl, application_name: "antero-whatsapp-channel" });
const SQLSTATE_MESSAGES = {
  "23505": "este Phone Number ID já está cadastrado em outro canal.",
  WH010: "esta WABA já está vinculada a outra organização.",
  WH011: "a identidade de um canal cloud_api (organização, número, WABA) não muda; cadastre outro canal.",
  "23514": "identificadores fora do formato aceito pelo banco.",
};

async function main() {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    const session = (
      await client.query("SELECT current_user AS role, session_user AS login, current_database() AS database")
    ).rows[0];
    if (session.role !== "antero_owner" || session.login !== "antero_migrator") {
      throw new Error("a conexão não opera como antero_owner via antero_migrator.");
    }
    if (expectedDatabase && session.database !== expectedDatabase) {
      throw new Error("o banco conectado não é o alvo esperado.");
    }

    const organization = (
      await client.query("SELECT id, name, status FROM public.organizations WHERE id = $1::uuid FOR SHARE", [input.organizationId])
    ).rows[0];
    if (!organization) throw new Error("organização não encontrada.");
    if (organization.status !== "active") throw new Error("organização suspensa: reative-a antes de cadastrar o canal.");
    console.log(`${TAG} organização: ${organization.name} (${organization.id})`);

    const existing = (
      await client.query(
        `SELECT id, organization_id, external_business_account_id, status
         FROM public.whatsapp_accounts
         WHERE provider = 'cloud_api' AND external_account_id = $1
         FOR UPDATE`,
        [input.phoneNumberId],
      )
    ).rows[0];

    let action;
    if (existing) {
      if (existing.organization_id !== input.organizationId) {
        throw new Error("este Phone Number ID já está cadastrado em OUTRA organização. Nada foi alterado.");
      }
      if (existing.external_business_account_id !== input.wabaId) {
        throw new Error("este Phone Number ID já está cadastrado nesta organização com outra WABA. Nada foi alterado.");
      }
      if (existing.status === input.status) {
        console.log(`${TAG} canal já cadastrado (${existing.id}), status ${existing.status}: nada a fazer.`);
        await client.query("ROLLBACK");
        return;
      }
      await client.query("UPDATE public.whatsapp_accounts SET status = $2 WHERE id = $1", [existing.id, input.status]);
      action = `canal ${existing.id}: status ${existing.status} → ${input.status}`;
    } else {
      const foreignWaba = (
        await client.query(
          `SELECT 1 FROM public.whatsapp_accounts
           WHERE provider = 'cloud_api' AND external_business_account_id = $1 AND organization_id <> $2::uuid
           LIMIT 1`,
          [input.wabaId, input.organizationId],
        )
      ).rowCount;
      if (foreignWaba) throw new Error("esta WABA já está vinculada a OUTRA organização. Nada foi alterado.");
      const created = (
        await client.query(
          `INSERT INTO public.whatsapp_accounts
             (organization_id, provider, status, external_account_id, external_business_account_id, phone_number, display_name)
           VALUES ($1::uuid, 'cloud_api', $2, $3, $4, $5, $6)
           RETURNING id`,
          [input.organizationId, input.status, input.phoneNumberId, input.wabaId, input.displayPhone, input.displayName],
        )
      ).rows[0];
      action = `canal cloud_api criado (${created.id}), status ${input.status}`;
    }

    if (values.apply) {
      await client.query("COMMIT");
      console.log(`${TAG} GRAVADO: ${action}.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`${TAG} SIMULAÇÃO: ${action}. Nada foi gravado; repita com --apply para gravar.`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const known = SQLSTATE_MESSAGES[error?.code];
    if (known) throw new Error(`${known} Nada foi alterado.`);
    throw error;
  }
}

try {
  await main();
} catch (error) {
  // Só a mensagem própria ou o SQLSTATE: nunca a conexão nem a senha.
  const message = error?.code ? `falha na conexão ou no banco (código ${error.code}). Nada foi alterado.` : error?.message ?? "erro desconhecido";
  console.error(`${TAG} ERRO: ${message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
