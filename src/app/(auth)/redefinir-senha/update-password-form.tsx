"use client";

import { useActionState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { updatePassword, type AuthFormState } from "@/modules/auth/actions";

export function UpdatePasswordForm() {
  const [state, action] = useActionState<AuthFormState, FormData>(
    updatePassword,
    undefined,
  );

  return (
    <Card>
      <CardContent className="p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">
            Definir nova senha
          </h1>
          <p className="text-sm text-muted">
            Escolha uma nova senha para sua conta.
          </p>
        </div>

        <form action={action} className="mt-6 space-y-4">
          <Field
            label="Nova senha"
            htmlFor="password"
            errors={state?.fieldErrors?.password}
          >
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
            />
          </Field>

          <Field
            label="Confirmar nova senha"
            htmlFor="confirm"
            errors={state?.fieldErrors?.confirm}
          >
            <Input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
            />
          </Field>

          {state?.error && (
            <p className="text-sm text-red-400" role="alert">
              {state.error}
            </p>
          )}

          <SubmitButton className="w-full" pendingLabel="Salvando…">
            Salvar nova senha
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
