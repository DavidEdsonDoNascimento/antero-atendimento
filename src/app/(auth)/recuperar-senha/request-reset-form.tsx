"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { IconCheck } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  requestPasswordReset,
  type AuthFormState,
} from "@/modules/auth/actions";

export function RequestResetForm() {
  const [state, action] = useActionState<AuthFormState, FormData>(
    requestPasswordReset,
    undefined,
  );

  return (
    <Card>
      <CardContent className="p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">
            Recuperar senha
          </h1>
          <p className="text-sm text-muted">
            Informe seu e-mail e enviaremos um link para redefinir a senha.
          </p>
        </div>

        {state?.success ? (
          <div className="mt-6 flex items-start gap-3 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-200">
            <IconCheck className="mt-0.5 size-4 shrink-0" />
            <span>{state.success}</span>
          </div>
        ) : (
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

            <SubmitButton className="w-full" pendingLabel="Enviando…">
              Enviar link
            </SubmitButton>
          </form>
        )}

        <div className="mt-4 text-center text-sm">
          <Link
            href="/login"
            className="text-muted transition-colors hover:text-gold"
          >
            Voltar para o login
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
