"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import {
  loginSchema,
  requestResetSchema,
  updatePasswordSchema,
} from "./schema";

export type AuthFormState =
  | {
      error?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      success?: string;
    }
  | undefined;

async function getOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

export async function login(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Registra o erro real do Supabase no servidor para diagnóstico. Nunca é
    // exposto ao navegador — a mensagem devolvida ao usuário é sempre genérica.
    console.error("[auth.login] signInWithPassword falhou", {
      name: error.name,
      status: error.status,
      code: error.code,
      message: error.message,
    });

    // Casos que merecem uma mensagem específica (sem revelar se o e-mail existe).
    if (error.code === "email_not_confirmed") {
      return { error: "Confirme seu e-mail antes de entrar." };
    }
    if (error.code === "over_request_rate_limit" || error.status === 429) {
      return {
        error: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
      };
    }

    // `invalid_credentials` e demais falhas: mensagem neutra por segurança.
    return { error: "E-mail ou senha inválidos." };
  }

  redirect("/visao-geral");
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function requestPasswordReset(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = requestResetSchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const origin = await getOrigin();

  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/redefinir-senha`,
  });

  // Resposta neutra: não revelamos se o e-mail existe.
  return {
    success:
      "Se houver uma conta com este e-mail, enviaremos instruções para redefinir a senha.",
  };
}

export async function updatePassword(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = updatePasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      error:
        "Sessão de redefinição inválida ou expirada. Solicite um novo link.",
    };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    return { error: "Não foi possível atualizar a senha. Tente novamente." };
  }

  redirect("/visao-geral");
}
