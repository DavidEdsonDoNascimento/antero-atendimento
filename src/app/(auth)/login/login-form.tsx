"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { login, type AuthFormState } from "@/modules/auth/actions";

export function LoginForm({ notice }: { notice?: string }) {
  const [state, action] = useActionState<AuthFormState, FormData>(
    login,
    undefined,
  );

  return (
    <Card>
      <CardContent className="p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Entrar</h1>
          <p className="text-sm text-muted">
            Acesse a plataforma de atendimento.
          </p>
        </div>

        {notice && (
          <p className="mt-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-muted">
            {notice}
          </p>
        )}

        <form action={action} className="mt-6 space-y-4">
          <Field
            label="E-mail"
            htmlFor="email"
            errors={state?.fieldErrors?.email}
          >
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="voce@empresa.com"
            />
          </Field>

          <Field
            label="Senha"
            htmlFor="password"
            errors={state?.fieldErrors?.password}
          >
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>

          {state?.error && (
            <p className="text-sm text-red-400" role="alert">
              {state.error}
            </p>
          )}

          <SubmitButton className="w-full" pendingLabel="Entrando…">
            Entrar
          </SubmitButton>
        </form>

        <div className="mt-4 text-center text-sm">
          <Link
            href="/recuperar-senha"
            className="text-muted transition-colors hover:text-gold"
          >
            Esqueceu a senha?
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
