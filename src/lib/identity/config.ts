import { isIP } from "node:net";

import { z } from "zod";

// Extensão .ts explícita: importação de VALOR, para o ESM nativo do Node
// resolver nos testes (ver nota em modules/conversations/cursor.ts).
import { IdentityConfigError } from "./errors.ts";

// Lógica pura (parsing/validação, sem I/O) — sem `import "server-only"` para
// ser testável com `node --test`. Quem lê `process.env` é `auth.ts`
// (server-only).

/** Único papel com que a identidade (Better Auth) pode conectar. */
export const AUTH_DATABASE_ROLE = "antero_auth";

/**
 * Configuração da identidade, lida SÓ de variáveis de ambiente do servidor
 * (nunca `NEXT_PUBLIC_*`):
 *
 *   AUTH_DATABASE_URL                    postgres://antero_auth:<senha>@host:porta/banco[?sslmode=…]
 *   AUTH_DATABASE_POOL_MAX               conexões simultâneas (1–20, padrão 5)
 *   AUTH_DATABASE_CONNECT_TIMEOUT_MS     espera por conexão (padrão 5000)
 *   AUTH_DATABASE_IDLE_TIMEOUT_MS        fecha conexão ociosa após (padrão 30000)
 *   AUTH_DATABASE_STATEMENT_TIMEOUT_MS   limite por comando no servidor (padrão 10000)
 *   BETTER_AUTH_SECRET                   assina cookies (≥ 32 caracteres, aleatório)
 *   BETTER_AUTH_URL                      origem pública da aplicação (https; http só em loopback)
 *   AUTH_TRUSTED_PROXIES                 IPs/CIDRs dos proxies reversos (ex.: Traefik), separados por vírgula
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE    servidor de e-mail (Mailpit no local)
 *   SMTP_USER, SMTP_PASSWORD             credenciais SMTP (as duas ou nenhuma)
 *   MAIL_FROM                            remetente dos e-mails de autenticação
 */
export type IdentityConfig = {
  database: {
    connectionString: string;
    host: string;
    port: number;
    database: string;
    poolMax: number;
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    statementTimeoutMs: number;
    /** Encerra no servidor transações abandonadas abertas (não configurável). */
    idleInTransactionTimeoutMs: number;
  };
  secret: string;
  /** Origem pública, sem barra final (ex.: https://atendimento.exemplo.com). */
  baseURL: string;
  /** Cookies `Secure` + prefixo `__Secure-` (sempre que a origem é https). */
  secureCookies: boolean;
  trustedProxies: string[];
  mail: {
    host: string;
    port: number;
    secure: boolean;
    /** Exige STARTTLS quando a conexão não começa cifrada (produção). */
    requireTLS: boolean;
    auth: { user: string; pass: string } | null;
    from: string;
  };
  production: boolean;
};

const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
const ALLOWED_URL_PARAMS = new Set(["sslmode"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MIN_SECRET_LENGTH = 32;

/** Valores de exemplo que nunca podem virar segredo de verdade. */
const PLACEHOLDER_SECRET = /^(?:better-auth-secret|changeme|change-me|secret|your-secret|<.*>)/i;

function intSetting(name: string, min: number, max: number, fallback: number) {
  return z
    .string()
    .trim()
    .regex(/^\d+$/, { error: `${name} deve ser um inteiro.` })
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(min, { error: `${name} deve ser no mínimo ${min}.` })
        .max(max, { error: `${name} deve ser no máximo ${max}.` }),
    )
    .optional()
    .transform((value) => value ?? fallback);
}

const required = (name: string) =>
  z.string({ error: `${name} é obrigatória.` }).trim().min(1, { error: `${name} é obrigatória.` });

const envSchema = z.object({
  AUTH_DATABASE_URL: required("AUTH_DATABASE_URL"),
  AUTH_DATABASE_POOL_MAX: intSetting("AUTH_DATABASE_POOL_MAX", 1, 20, 5),
  AUTH_DATABASE_CONNECT_TIMEOUT_MS: intSetting("AUTH_DATABASE_CONNECT_TIMEOUT_MS", 500, 60_000, 5_000),
  AUTH_DATABASE_IDLE_TIMEOUT_MS: intSetting("AUTH_DATABASE_IDLE_TIMEOUT_MS", 1_000, 600_000, 30_000),
  AUTH_DATABASE_STATEMENT_TIMEOUT_MS: intSetting("AUTH_DATABASE_STATEMENT_TIMEOUT_MS", 100, 300_000, 10_000),
  BETTER_AUTH_SECRET: z.string({ error: "BETTER_AUTH_SECRET é obrigatória." }),
  BETTER_AUTH_URL: required("BETTER_AUTH_URL"),
  AUTH_TRUSTED_PROXIES: z.string().optional(),
  SMTP_HOST: required("SMTP_HOST"),
  SMTP_PORT: intSetting("SMTP_PORT", 1, 65_535, 587),
  SMTP_SECURE: z.enum(["true", "false"], { error: "SMTP_SECURE deve ser true ou false." }).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: required("MAIL_FROM"),
});

/** Valida a URL do banco sem nunca incluir a senha (nem a URL) em mensagens. */
function parseDatabaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IdentityConfigError("AUTH_DATABASE_URL não é uma URL válida.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new IdentityConfigError("AUTH_DATABASE_URL deve usar o esquema postgres://.");
  }
  if (decodeURIComponent(url.username) !== AUTH_DATABASE_ROLE) {
    throw new IdentityConfigError(`AUTH_DATABASE_URL deve conectar com o papel ${AUTH_DATABASE_ROLE}.`);
  }
  if (!url.password) throw new IdentityConfigError("AUTH_DATABASE_URL deve conter a senha do papel.");
  if (!url.hostname) throw new IdentityConfigError("AUTH_DATABASE_URL deve conter o host.");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) {
    throw new IdentityConfigError("AUTH_DATABASE_URL deve conter o nome do banco.");
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key)) {
      throw new IdentityConfigError(
        `AUTH_DATABASE_URL: parâmetro "${key}" não é permitido (aceitos: ${[...ALLOWED_URL_PARAMS].join(", ")}).`,
      );
    }
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 5432,
    database,
  };
}

/** Segredo longo e não trivial. A mensagem nunca ecoa o valor. */
function validateSecret(secret: string): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new IdentityConfigError(
      `BETTER_AUTH_SECRET deve ter ao menos ${MIN_SECRET_LENGTH} caracteres (gere com \`openssl rand -base64 32\`).`,
    );
  }
  if (PLACEHOLDER_SECRET.test(secret) || new Set(secret).size < 12) {
    throw new IdentityConfigError("BETTER_AUTH_SECRET parece um valor de exemplo; gere um segredo aleatório.");
  }
  return secret;
}

/** Origem pública: https, ou http apenas em loopback (desenvolvimento/testes). */
function parseBaseURL(raw: string, production: boolean) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IdentityConfigError("BETTER_AUTH_URL não é uma URL válida.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new IdentityConfigError("BETTER_AUTH_URL deve usar http:// ou https://.");
  }
  if (url.username || url.password) {
    throw new IdentityConfigError("BETTER_AUTH_URL não pode conter credenciais.");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new IdentityConfigError("BETTER_AUTH_URL deve ser só a origem (ex.: https://atendimento.exemplo.com).");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol === "http:" && (production || !loopback)) {
    throw new IdentityConfigError("BETTER_AUTH_URL deve usar https:// (http só em localhost fora de produção).");
  }
  return { baseURL: url.origin, secureCookies: url.protocol === "https:" };
}

function parseTrustedProxies(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address ?? "");
    const prefixOk =
      prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32));
    if (!family || extra !== undefined || !prefixOk) {
      throw new IdentityConfigError(`AUTH_TRUSTED_PROXIES: "${entry}" não é um IP ou CIDR válido.`);
    }
  }
  return entries;
}

/** Lê e valida a configuração. Lança `IdentityConfigError` (sem segredos). */
export function parseIdentityConfig(env: Record<string, string | undefined>): IdentityConfig {
  const blankToUndefined = (value: string | undefined) => (value === "" ? undefined : value);
  const parsed = envSchema.safeParse({
    AUTH_DATABASE_URL: env.AUTH_DATABASE_URL,
    AUTH_DATABASE_POOL_MAX: blankToUndefined(env.AUTH_DATABASE_POOL_MAX),
    AUTH_DATABASE_CONNECT_TIMEOUT_MS: blankToUndefined(env.AUTH_DATABASE_CONNECT_TIMEOUT_MS),
    AUTH_DATABASE_IDLE_TIMEOUT_MS: blankToUndefined(env.AUTH_DATABASE_IDLE_TIMEOUT_MS),
    AUTH_DATABASE_STATEMENT_TIMEOUT_MS: blankToUndefined(env.AUTH_DATABASE_STATEMENT_TIMEOUT_MS),
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    AUTH_TRUSTED_PROXIES: env.AUTH_TRUSTED_PROXIES,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: blankToUndefined(env.SMTP_PORT),
    SMTP_SECURE: blankToUndefined(env.SMTP_SECURE),
    SMTP_USER: blankToUndefined(env.SMTP_USER),
    SMTP_PASSWORD: blankToUndefined(env.SMTP_PASSWORD),
    MAIL_FROM: env.MAIL_FROM,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n");
    throw new IdentityConfigError(`Configuração da identidade inválida:\n${issues}`);
  }
  const settings = parsed.data;
  const production = env.NODE_ENV === "production";

  if (Boolean(settings.SMTP_USER) !== Boolean(settings.SMTP_PASSWORD)) {
    throw new IdentityConfigError("SMTP_USER e SMTP_PASSWORD devem ser informadas juntas.");
  }
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(settings.MAIL_FROM.replace(/^.*<([^>]+)>\s*$/, "$1"))) {
    throw new IdentityConfigError("MAIL_FROM deve conter um endereço de e-mail.");
  }
  const smtpSecure = settings.SMTP_SECURE === "true";
  const trustedProxies = parseTrustedProxies(settings.AUTH_TRUSTED_PROXIES);
  // Sem proxy confiável, o Better Auth não aceita um X-Forwarded-For com
  // vários saltos como IP do cliente e põe todos num balde único de rate
  // limit: 5 tentativas erradas por minuto bloqueariam o login de TODOS.
  if (production && trustedProxies.length === 0) {
    throw new IdentityConfigError(
      "AUTH_TRUSTED_PROXIES é obrigatória em produção (IP/CIDR do proxy reverso que define X-Forwarded-For).",
    );
  }

  return {
    database: {
      connectionString: settings.AUTH_DATABASE_URL,
      ...parseDatabaseUrl(settings.AUTH_DATABASE_URL),
      poolMax: settings.AUTH_DATABASE_POOL_MAX,
      connectTimeoutMs: settings.AUTH_DATABASE_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: settings.AUTH_DATABASE_IDLE_TIMEOUT_MS,
      statementTimeoutMs: settings.AUTH_DATABASE_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    secret: validateSecret(settings.BETTER_AUTH_SECRET),
    ...parseBaseURL(settings.BETTER_AUTH_URL, production),
    trustedProxies,
    mail: {
      host: settings.SMTP_HOST,
      port: settings.SMTP_PORT,
      secure: smtpSecure,
      requireTLS: production && !smtpSecure,
      auth: settings.SMTP_USER ? { user: settings.SMTP_USER, pass: settings.SMTP_PASSWORD as string } : null,
      from: settings.MAIL_FROM,
    },
    production,
  };
}

/** Destino local (loopback) — usado pelo provisionamento para recusar alvos remotos. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/^\[|\]$/g, ""));
}
