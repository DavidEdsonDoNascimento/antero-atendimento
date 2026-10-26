import type { BetterAuthOptions } from "better-auth";
import { PostgresDialect } from "kysely";
import type pg from "pg";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { BETTER_AUTH_DB_SCHEMA, betterAuthSchemaOptions } from "../auth/better-auth-options.ts";
import type { IdentityConfig } from "./config";
import {
  IDENTITY_BASE_PATH,
  IDENTITY_COOKIE_PREFIX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RESET_PAGE,
} from "./constants.ts";
import type { IdentityMailer } from "./mailer";

// Sem `import "server-only"`: só monta o objeto de opções (sem I/O), para o
// provisionamento local e os testes o reaproveitarem. A instância usada pela
// aplicação é criada em `auth.ts` (server-only).

export { IDENTITY_BASE_PATH, IDENTITY_COOKIE_PREFIX, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_RESET_PAGE };
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 60 * 60;
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_REFRESH_AGE_SECONDS = 60 * 60 * 24;

/**
 * Limites por IP + rota (memória do processo — ver docs/AUTH.md). Mais
 * restritos que os padrões do Better Auth para login (3 a cada 10 s → até
 * ~1 000/h) e para pedidos de redefinição.
 */
export const IDENTITY_RATE_LIMITS = {
  "/sign-in/email": { window: 60, max: 5 },
  "/request-password-reset": { window: 300, max: 3 },
  "/reset-password": { window: 300, max: 5 },
  "/change-password": { window: 300, max: 5 },
} as const;

/**
 * Rotas do Better Auth desligadas no handler HTTP (404). Cadastro público,
 * login social, gestão de conta pelo usuário e verificação de e-mail não
 * fazem parte do produto: usuários são provisionados, e dados de perfil
 * ficam em `public.profiles` (aplicação + RLS).
 */
export const IDENTITY_DISABLED_PATHS = [
  "/sign-up/email",
  "/sign-in/social",
  "/update-user",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
  "/refresh-token",
  "/get-access-token",
  "/send-verification-email",
  "/verify-email",
  "/update-session",
];

export type IdentityLogSink = (level: "debug" | "info" | "warn" | "error", message: string) => void;

const defaultLogSink: IdentityLogSink = (level, message) => {
  (level === "error" ? console.error : console.warn)(`[auth] ${message}`);
};

/**
 * Remove de mensagens de log tokens (query `token=`, caminho
 * `/reset-password/<token>`), `callbackURL`s e e-mails. O Better Auth registra,
 * por exemplo, o callback recusado e o e-mail de um cadastro duplicado.
 */
export function redactLogMessage(message: string): string {
  return message
    .replace(/([?&](?:token|callbackURL|redirectTo)=)[^&\s"']+/gi, "$1[redigido]")
    .replace(/(\/reset-password\/)[^?\s/"']+/gi, "$1[redigido]")
    .replace(/[^\s@<>"'(),:;]+@[^\s@<>"'(),:;]+\.[^\s@<>"'(),:;]+/g, "[e-mail]")
    .replace(/(Invalid (?:callbackURL|redirectURL|origin): ).*/i, "$1[redigido]");
}

/** Só nome/código de erros passados como argumento — nunca o objeto inteiro. */
function describeArgs(args: unknown[]): string {
  const parts = args
    .map((arg) => {
      if (arg instanceof Error) {
        const code = (arg as { code?: unknown }).code;
        return typeof code === "string" ? `${arg.name} ${code}` : arg.name;
      }
      return null;
    })
    .filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export type IdentityOptionsInput = {
  config: IdentityConfig;
  pool: pg.Pool;
  mailer: IdentityMailer;
  logSink?: IdentityLogSink;
};

/**
 * Opções do Better Auth 1.7.12 sobre o PostgreSQL próprio. As opções que
 * definem o SCHEMA vêm de `betterAuthSchemaOptions` (fonte única com a
 * migration 0000 e o verificador `pnpm db:auth-schema`); aqui entram só as de
 * comportamento — nenhuma delas cria tabela ou coluna (o rate limit fica em
 * memória e não há plugins).
 */
export function buildIdentityAuthOptions({
  config,
  pool,
  mailer,
  logSink = defaultLogSink,
}: IdentityOptionsInput) {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]) =>
    logSink(level, `${redactLogMessage(message)}${describeArgs(args)}`);

  return {
    ...betterAuthSchemaOptions,
    appName: "Antero Atendimento",
    baseURL: config.baseURL,
    basePath: IDENTITY_BASE_PATH,
    secret: config.secret,
    trustedOrigins: [config.baseURL],
    database: {
      dialect: new PostgresDialect({ pool }),
      type: "postgres",
      schemaName: BETTER_AUTH_DB_SCHEMA,
      // Padrão é false no formato `dialect`: sem isto, redefinir a senha
      // (consumir o token + revogar sessões + gravar o hash) não seria atômico.
      transaction: true,
    },
    emailAndPassword: {
      ...betterAuthSchemaOptions.emailAndPassword,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // Não espera o SMTP: a resposta (neutra) leva o mesmo tempo exista ou
      // não o e-mail. Falhas de envio são registradas sem dados pessoais.
      sendResetPassword: async ({ user, url }) => {
        mailer.sendPasswordReset({ to: user.email, name: user.name, url }).catch((error: unknown) => {
          log("error", "Falha ao enviar o e-mail de redefinição de senha", error);
        });
      },
    },
    session: {
      ...betterAuthSchemaOptions.session,
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_REFRESH_AGE_SECONDS,
      // Toda leitura de sessão vai ao banco: logout/revogação valem na hora.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: { ...IDENTITY_RATE_LIMITS },
    },
    advanced: {
      ...betterAuthSchemaOptions.advanced,
      // Explícito: com NODE_ENV=test o Better Auth DESLIGA a checagem de
      // origem (e, por compatibilidade, a de CSRF e a validação de
      // callbackURL/redirectTo). Aqui elas valem em todos os ambientes.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: IDENTITY_COOKIE_PREFIX,
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for"],
        trustedProxies: config.trustedProxies,
      },
    },
    disabledPaths: IDENTITY_DISABLED_PATHS,
    telemetry: { enabled: false },
    logger: { level: "warn", log },
  } satisfies BetterAuthOptions;
}
