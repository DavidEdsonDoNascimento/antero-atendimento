"use client";

import { useActionState } from "react";

import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { createFlowAction, type CreateFlowState } from "@/modules/automations/editor-actions";

const INITIAL: CreateFlowState = { status: "idle" };

export function CreateFlowForm({ entryFlowName }: { entryFlowName: string | null }) {
  const [state, formAction] = useActionState(createFlowAction, INITIAL);
  return (
    <Card className="max-w-xl p-5">
      <form action={formAction} className="space-y-5">
        <Field label="Nome da automação" htmlFor="name" errors={state.status === "error" && state.fieldErrors?.name ? [state.fieldErrors.name] : undefined}>
          <Input id="name" name="name" required maxLength={120} placeholder="Ex.: Atendimento do restaurante" autoFocus />
        </Field>
        <div className="space-y-1">
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="isEntry"
              defaultChecked={entryFlowName === null}
              disabled={entryFlowName !== null}
              className="mt-0.5 size-4 accent-[var(--color-gold)]"
            />
            <span>Responder automaticamente às conversas novas</span>
          </label>
          <p className="pl-6 text-xs text-muted-2">
            {entryFlowName === null
              ? "Quando um cliente escrever pela primeira vez, esta automação responde (depois de publicada)."
              : `“${entryFlowName}” já responde às conversas novas. Só uma automação por vez pode fazer isso.`}
          </p>
        </div>
        <p className="text-xs text-muted-2">
          A automação começa com uma mensagem de boas-vindas, um menu e a opção de falar com a equipe. Você ajusta tudo
          na próxima tela — nada é publicado até você publicar.
        </p>
        {state.status === "error" && !state.fieldErrors && (
          <p role="alert" className="text-sm text-red-300">
            {state.message}
          </p>
        )}
        <SubmitButton pendingLabel="Criando…">Criar automação</SubmitButton>
      </form>
    </Card>
  );
}
