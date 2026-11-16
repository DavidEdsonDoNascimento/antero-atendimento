"use client";

import { useActionState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { setFlowStatusAction, type FlowStatusState } from "@/modules/automations/editor-actions";
import type { AutomationFlowStatus } from "@/lib/types/database";

const INITIAL: FlowStatusState = { status: "idle" };

/** Pausar ou reativar uma automação publicada. */
export function FlowStatusForm({ flowId, status }: { flowId: string; status: AutomationFlowStatus }) {
  const [state, formAction, pending] = useActionState(setFlowStatusAction, INITIAL);
  if (status === "draft") return null;
  const next = status === "active" ? "paused" : "active";
  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="flowId" value={flowId} />
      <input type="hidden" name="status" value={next} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
        title={next === "paused" ? "Novas conversas deixam de receber respostas automáticas" : undefined}
      >
        {pending ? (next === "paused" ? "Pausando…" : "Reativando…") : next === "paused" ? "Pausar" : "Reativar"}
      </button>
      {state.status !== "idle" && (
        <p role={state.status === "success" ? "status" : "alert"} className={cn("text-xs", state.status === "success" ? "text-emerald-300" : "text-red-300")}>
          {state.message}
        </p>
      )}
    </form>
  );
}
