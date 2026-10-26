/**
 * Apoio dos testes da identidade (Entrega 5A): Better Auth REAL sobre o banco
 * descartável (antero_auth), exercitado pelo handler HTTP do próprio Better
 * Auth via `handleIdentityRequest(Request) → Response` (o mesmo que a Entrega
 * 5B montará em `app/api/auth/[...all]`), com cookies de verdade e e-mails no
 * Mailpit.
 *
 * Importe DEPOIS de harness.ts (que confere os alvos de teste).
 */
import { randomBytes } from "node:crypto";

import type pg from "pg";

import { createIdentityAuth, type IdentityAuth } from "../../src/lib/identity/auth.ts";
import { parseIdentityConfig, type IdentityConfig } from "../../src/lib/identity/config.ts";
import { handleIdentityRequest } from "../../src/lib/identity/handler.ts";
import { createSmtpMailer } from "../../src/lib/identity/mailer.ts";
import { IDENTITY_BASE_PATH } from "../../src/lib/identity/options.ts";
import { createIdentityPool } from "../../src/lib/identity/pool.ts";
import { createLocalProvisioner } from "../../src/lib/identity/provision.ts";
import { connectFixtureClient } from "./harness.ts";

export type TestIdentity = {
  auth: IdentityAuth;
  pool: pg.Pool;
  config: IdentityConfig;
  logs: string[];
  close(): Promise<void>;
};

/** Configuração da identidade dos testes (variáveis montadas por `pnpm db:test:integration`). */
export function testIdentityConfig(overrides: Record<string, string> = {}): IdentityConfig {
  return parseIdentityConfig({ ...process.env, ...overrides });
}

/** Instância real do Better Auth com pool e SMTP próprios; registra os logs. */
export function createTestIdentity(config: IdentityConfig = testIdentityConfig()): TestIdentity {
  const pool = createIdentityPool(config.database);
  const mailer = createSmtpMailer(config.mail);
  const logs: string[] = [];
  const auth = createIdentityAuth({
    config,
    pool,
    mailer,
    logSink: (level, message) => logs.push(`${level}: ${message}`),
  });
  return {
    auth,
    pool,
    config,
    logs,
    async close() {
      mailer.close();
      await pool.end();
    },
  };
}

let ipCounter = 0;
/** IP de cliente único por chamada (o rate limit é por IP + rota). */
export function uniqueIp(): string {
  ipCounter += 1;
  return `10.${(process.pid % 250) + 1}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  ip?: string;
  origin?: string | null;
  headers?: Record<string, string>;
};

/**
 * Navegador mínimo: guarda os cookies recebidos (`Set-Cookie`) e os reenvia,
 * como um navegador real faria para a origem da aplicação.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly ip: string;
  private readonly identity: TestIdentity;

  constructor(identity: TestIdentity, ip = uniqueIp()) {
    this.identity = identity;
    this.ip = ip;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const { baseURL } = this.identity.config;
    const headers = new Headers(options.headers);
    headers.set("x-forwarded-for", options.ip ?? this.ip);
    if (options.origin !== null) headers.set("origin", options.origin ?? baseURL);
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const response = await handleIdentityRequest(
      new Request(`${baseURL}${IDENTITY_BASE_PATH}${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        redirect: "manual",
      }),
      this.identity.auth,
    );
    this.storeCookies(response);
    return response;
  }

  storeCookies(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some(
        (attribute) =>
          /^max-age=0$/i.test(attribute) ||
          (/^expires=/i.test(attribute) && Date.parse(attribute.slice(8)) <= Date.now()),
      );
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  signIn(email: string, password: string, ip?: string) {
    return this.request("/sign-in/email", { body: { email, password }, ip });
  }

  /** Cabeçalhos como os de uma requisição do navegador (para `auth.api.*` no servidor). */
  headers(): Headers {
    const headers = new Headers({ "x-forwarded-for": this.ip });
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    return headers;
  }
}

export type ProvisionedUser = { userId: string; email: string; password: string };

/**
 * Cria identidades fictícias pelo provisionamento local (fluxo oficial do
 * Better Auth) e as remove no fim. Os e-mails levam um sufixo aleatório.
 */
export async function provisionUsers<K extends string>(
  identity: TestIdentity,
  names: Record<K, string>,
): Promise<{ suffix: string; users: Record<K, ProvisionedUser> }> {
  const suffix = randomBytes(5).toString("hex");
  const provisioner = createLocalProvisioner({ config: identity.config, pool: identity.pool });
  const users = {} as Record<K, ProvisionedUser>;
  for (const [key, name] of Object.entries(names) as [K, string][]) {
    const result = await provisioner.provision({ email: `${key.toLowerCase()}.${suffix}@teste.local`, name });
    users[key] = { userId: result.userId, email: result.email, password: result.password as string };
  }
  return { suffix, users };
}

/** Remove identidades (sessões, contas e perfil caem em cascata) e tokens de redefinição. */
export async function dropUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const fixture = await connectFixtureClient();
  try {
    await fixture.query("DELETE FROM auth.verifications WHERE value = ANY($1::text[])", [userIds]);
    await fixture.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [userIds]);
  } finally {
    await fixture.end();
  }
}

// ---------------------------------------------------------------------------
// Mailpit (API HTTP local)
// ---------------------------------------------------------------------------

const MAILPIT = process.env.DB_TEST_MAILPIT_URL as string;

type MailpitSummary = { ID: string; To: { Address: string }[]; Subject: string };
export type MailpitMessage = { ID: string; Subject: string; Text: string; HTML: string; To: { Address: string }[] };

async function searchMail(to: string): Promise<MailpitSummary[]> {
  const response = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  if (!response.ok) throw new Error(`Mailpit respondeu ${response.status}`);
  const { messages } = (await response.json()) as { messages: MailpitSummary[] };
  return messages.filter((message) => message.To.some((recipient) => recipient.Address === to));
}

export async function mailCount(to: string): Promise<number> {
  return (await searchMail(to)).length;
}

/** Espera o próximo e-mail para `to` (além dos `already` já vistos). */
export async function waitForMail(to: string, already = 0, timeoutMs = 5_000): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await searchMail(to);
    if (messages.length > already) {
      const response = await fetch(`${MAILPIT}/api/v1/message/${messages[0].ID}`);
      return (await response.json()) as MailpitMessage;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("e-mail não chegou ao Mailpit dentro do prazo");
}

/** Apaga do Mailpit só as mensagens destes destinatários. */
export async function deleteMail(recipients: string[]): Promise<void> {
  const ids = (await Promise.all(recipients.map(searchMail))).flat().map((message) => message.ID);
  if (ids.length === 0) return;
  await fetch(`${MAILPIT}/api/v1/messages`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ IDs: ids }),
  });
}
