import type { BetterAuthOptions } from "better-auth";

/**
 * Opções do Better Auth que determinam o SCHEMA do banco (Entrega 2).
 *
 * Este arquivo NÃO instancia o Better Auth e não é importado por nenhuma
 * página, ação ou proxy: a autenticação em runtime continua no Supabase até a
 * Entrega 5. Ele existe para que o schema versionado em
 * `db/migrations/0000_identity.sql` e a configuração que a Entrega 5 usará
 * sejam a MESMA fonte — `pnpm db:test:auth-schema` compara os dois com o
 * planejador de migrations do próprio Better Auth.
 *
 * Na Entrega 5: `betterAuth({ ...betterAuthSchemaOptions, database: {
 * dialect, type: "postgres", schemaName: BETTER_AUTH_DB_SCHEMA }, ... })`,
 * conectando como `antero_auth`. Qualquer opção que mude o schema (plugins,
 * campos adicionais, `rateLimit.storage = "database"`, nomes) exige uma nova
 * migration e deve entrar AQUI, não direto na chamada de `betterAuth()`.
 *
 * Decisões:
 * - Tabelas no schema `auth` (separado de `public`): `antero_app` não tem
 *   USAGE nele, então não lê hashes de senha nem tokens de sessão.
 * - Ids `uuid` (`generateId: "uuid"`): `profiles.id`,
 *   `organization_members.user_id`, `conversations.assigned_user_id` e
 *   `messages.sender_user_id` continuam `uuid`, como no modelo original.
 * - Tabelas no plural e colunas em snake_case, como o resto do banco.
 */
export const BETTER_AUTH_DB_SCHEMA = "auth";

export const betterAuthSchemaOptions = {
  emailAndPassword: { enabled: true },
  advanced: { database: { generateId: "uuid" } },
  user: {
    modelName: "users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    modelName: "sessions",
    fields: {
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      userId: "user_id",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  account: {
    modelName: "accounts",
    fields: {
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
} satisfies BetterAuthOptions;
