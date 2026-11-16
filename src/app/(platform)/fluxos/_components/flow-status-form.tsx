"use client";

import { useActionState } from "react";

import { buttonVariants } from "@/components/ui/button";
import type { AutomationFlowStatus } from "@/lib/types/database";
import { cn } from "@/lib/utils/cn";
import { setFlowStatusAction, type FlowStatusState } from "@/modules/automations/editor-actions";

const INITIAL: FlowStatusState = { status: "idle" };

/**
 * Só o botão de pausar/reativar. O editor usa este, com o resultado da ação na
 * área de avisos do cabeçalho (uma frase longa ao lado dos botões desorganiza a linha).
 */
export function FlowStatusButton({
  flowId,
  status,
  action,
  pending,
}: {
  flowId: string;
  status: AutomationFlowStatus;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  if (status === "draft") return null;
  const next = status === "active" ? "paused" : "active";
  return (
    <form action={action}>
      <input type="hidden" name="flowId" value={flowId} />
      <input type="hidden" name="status" value={next} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={buttonVariants({ variant: "secondary" })}
        title={next === "paused" ? "Novas conversas deixam de receber respostas automáticas" : undefined}
      >
        {pending ? (next === "paused" ? "Pausando…" : "Reativando…") : next === "paused" ? "Pausar" : "Reativar"}
      </button>
    </form>
  );
}

/** Pausar ou reativar com a mensagem do resultado logo abaixo (lista de automações). */
export function FlowStatusForm({ flowId, status }: { flowId: string; status: AutomationFlowStatus }) {
  const [state, formAction, pending] = useActionState(setFlowStatusAction, INITIAL);
  if (status === "draft") return null;
  return (
    <div className="flex max-w-xs flex-col items-start gap-1">
      <FlowStatusButton flowId={flowId} status={status} action={formAction} pending={pending} />
      {state.status !== "idle" && (
        <p role={state.status === "success" ? "status" : "alert"} className={cn("text-xs", state.status === "success" ? "text-emerald-300" : "text-red-300")}>
          {state.message}
        </p>
      )}
    </div>
  );
}
