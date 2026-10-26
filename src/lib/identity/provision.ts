import "server-only";

import { randomBytes } from "node:crypto";

import { betterAuth } from "better-auth";
import type pg from "pg";
import { z } from "zod";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { isLoopbackHost, type IdentityConfig } from "./config.ts";
import { ProvisioningRefusedError } from "./errors.ts";
import type { IdentityMailer } from "./mailer";
import { PASSWORD_MIN_LENGTH, buildIdentityAuthOptions } from "./options.ts";

/**
 * Provisionamento LOCAL de identidades fictícias (desenvolvimento e testes),
 * sem cadastro público: a aplicação mantém `disableSignUp` e a rota
 * `/sign-up/email` desligada. Aqui, uma instância PRIVADA do Better Auth —
 * nunca montada em HTTP, só usada por `pnpm auth:provision` e pelos testes —
 * executa o fluxo oficial de cadastro (`auth.api.signUpEmail`: mesma
 * transação, mesma normalização de e-mail e o hash de senha da biblioteca).
 * O perfil nasce pelo gatilho `handle_new_user`, como para qualquer usuário.
 *
 * - Recusa produção, banco fora de loopback e origem que não seja loopback.
 * - Idempotente por e-mail: repetir não duplica; `rotatePassword` troca a
 *   senha (e encerra as sessões da conta).
 * - Senha gerada aleatoriamente quando não informada; devolvida UMA vez para
 *   quem chamou, nunca registrada nem gravada.
 * - Não vincula a organizações nem mexe em `is_platform_admin`: o papel
 *   `antero_auth` não tem acesso a `public`. Vínculos são feitos à parte (as
 *   fixtures de teste usam o dono das tabelas no banco descartável).
 *
 * Não importe em rotas/actions (regra de lint em eslint.config.mjs).
 */

export type ProvisionRequest = {
  email: string;
  name: string;
  /** Opcional: senão, uma senha aleatória é gerada. */
  password?: string;
  /** Para um e-mail que já existe: define uma nova senha. */
  rotatePassword?: boolean;
};

export type ProvisionResult = {
  userId: string;
  email: string;
  created: boolean;
  /** A senha, só quando foi definida agora (criação ou rotação). */
  password: string | null;
};

const noopMailer: IdentityMailer = {
  async sendPasswordReset() {},
  close() {},
};

const requestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "E-mail inválido." })),
  name: z.string().trim().min(1, { error: "Informe o nome." }).max(120, { error: "Nome longo demais." }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { error: `A senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.` })
    .max(128, { error: "Senha longa demais." })
    .optional(),
  rotatePassword: z.boolean().optional(),
});

/** Recusa qualquer alvo que não seja o ambiente local. */
export function assertLocalProvisioningTarget(
  config: IdentityConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  if (config.production || env.NODE_ENV === "production") {
    throw new ProvisioningRefusedError("Provisionamento recusado: ambiente de produção.");
  }
  if (!isLoopbackHost(config.database.host)) {
    throw new ProvisioningRefusedError("Provisionamento recusado: o banco não é local (loopback).");
  }
  if (!isLoopbackHost(new URL(config.baseURL).hostname)) {
    throw new ProvisioningRefusedError("Provisionamento recusado: BETTER_AUTH_URL não é local.");
  }
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url"); // 24 caracteres
}

export function createLocalProvisioner({ config, pool }: { config: IdentityConfig; pool: pg.Pool }) {
  assertLocalProvisioningTarget(config);
  const base = buildIdentityAuthOptions({ config, pool, mailer: noopMailer, logSink: () => {} });
  const auth = betterAuth({
    ...base,
    // Só nesta instância privada: o cadastro passa pelo fluxo oficial, sem
    // abrir sessão (autoSignIn: false) e sem handler HTTP.
    emailAndPassword: { ...base.emailAndPassword, disableSignUp: false, autoSignIn: false },
    rateLimit: { enabled: false },
  });

  return {
    async provision(input: ProvisionRequest): Promise<ProvisionResult> {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) {
        throw new ProvisioningRefusedError(parsed.error.issues.map((issue) => issue.message).join(" "));
      }
      const request = parsed.data;
      const ctx = await auth.$context;
      const existing = await ctx.internalAdapter.findUserByEmail(request.email, { includeAccounts: true });

      if (existing) {
        if (!request.rotatePassword) {
          return { userId: existing.user.id, email: request.email, created: false, password: null };
        }
        const password = request.password ?? generatePassword();
        const hash = await ctx.password.hash(password);
        const userId = existing.user.id;
        if (existing.accounts.some((account) => account.providerId === "credential")) {
          await ctx.internalAdapter.updatePassword(userId, hash);
        } else {
          await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
        }
        await ctx.internalAdapter.deleteUserSessions(userId);
        return { userId, email: request.email, created: false, password };
      }

      const password = request.password ?? generatePassword();
      await auth.api.signUpEmail({ body: { email: request.email, name: request.name, password } });
      const created = await ctx.internalAdapter.findUserByEmail(request.email);
      if (!created) throw new ProvisioningRefusedError("A identidade não foi criada.");
      // Contas provisionadas por quem administra o ambiente: e-mail tido como verificado.
      await ctx.internalAdapter.updateUser(created.user.id, { emailVerified: true });
      return { userId: created.user.id, email: request.email, created: true, password };
    },
  };
}
