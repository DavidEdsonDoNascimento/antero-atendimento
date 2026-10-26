import { z } from "zod";

import { callIdentity, identityClient } from "@/lib/identity/client";
import { PASSWORD_RESET_PAGE } from "@/lib/identity/constants";

import {
  passwordResetFailureMessage,
  passwordResetRequestFailureMessage,
  signInFailureMessage,
} from "./messages";
import { loginSchema, requestResetSchema, updatePasswordSchema } from "./schema";

/**
 * Ações dos formulários de autenticação, executadas NO NAVEGADOR (form
 * actions de cliente com `useActionState`). Cada uma valida os campos com os
 * mesmos schemas de antes e chama o handler HTTP do Better Auth pelo cliente
 * oficial — logo, origem/CSRF e rate limit sempre se aplicam. Não existe
 * Server Action de login: ela chamaria `auth.api.*` e escaparia do limite.
 *
 * Os destinos depois do sucesso são caminhos FIXOS deste arquivo — nunca um
 * parâmetro da URL ou do formulário.
 */

export type AuthFormState =
  | {
      error?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      success?: string;
    }
  | undefined;

export const AFTER_SIGN_IN = "/visao-geral";
export const AFTER_PASSWORD_RESET = "/login?aviso=senha-redefinida";
export const AFTER_SIGN_OUT = "/login";

export type AuthActionResult = { state: AuthFormState; redirectTo?: string };

export async function signInWithPassword(formData: FormData): Promise<AuthActionResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { state: { fieldErrors: z.flattenError(parsed.error).fieldErrors } };
  }

  const failure = await callIdentity(() => identityClient().signIn.email(parsed.data));
  if (failure) return { state: { error: signInFailureMessage(failure) } };
  return { state: undefined, redirectTo: AFTER_SIGN_IN };
}

export async function requestPasswordReset(formData: FormData): Promise<AuthFormState> {
  const parsed = requestResetSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  // `redirectTo` relativo e fixo: o Better Auth recusa (403) destinos
  // externos, `//host` e esquemas como `javascript:`.
  const failure = await callIdentity(() =>
    identityClient().requestPasswordReset({ email: parsed.data.email, redirectTo: PASSWORD_RESET_PAGE }),
  );
  if (failure) return { error: passwordResetRequestFailureMessage(failure) };

  // Resposta neutra: não revelamos se o e-mail existe.
  return {
    success: "Se houver uma conta com este e-mail, enviaremos instruções para redefinir a senha.",
  };
}

export async function resetPassword(token: string, formData: FormData): Promise<AuthActionResult> {
  const parsed = updatePasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { state: { fieldErrors: z.flattenError(parsed.error).fieldErrors } };
  }

  const failure = await callIdentity(() =>
    identityClient().resetPassword({ token, newPassword: parsed.data.password }),
  );
  if (failure) return { state: { error: passwordResetFailureMessage(failure) } };
  // A troca revoga TODAS as sessões da conta: o usuário entra de novo.
  return { state: undefined, redirectTo: AFTER_PASSWORD_RESET };
}

/**
 * Encerra a sessão no servidor (apaga a linha em `auth.sessions` e o cookie)
 * e recarrega a aplicação inteira em /login, descartando o cache do roteador
 * com páginas protegidas.
 */
export async function signOut(): Promise<void> {
  await callIdentity(() => identityClient().signOut());
  window.location.replace(AFTER_SIGN_OUT);
}
