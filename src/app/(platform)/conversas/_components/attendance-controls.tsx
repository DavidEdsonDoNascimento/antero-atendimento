"use client";

import { useActionState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { updateAttendanceAction, type AttendanceActionState } from "@/modules/conversations/actions";
import type { AttendanceActions } from "@/modules/conversations/attendance";

import { ActionFeedback } from "./action-feedback";

const INITIAL_STATE: AttendanceActionState = { status: "idle" };

/**
 * Assumir e Resolver. A tela só mostra o que o banco aceitaria agora
 * (`attendanceActionsFor`); a decisão — inclusive a disputa entre dois
 * atendentes — é de `claim_conversation`/`resolve_conversation`.
 */
export function AttendanceControls({
  conversationId,
  actions,
}: {
  conversationId: string;
  actions: AttendanceActions;
}) {
  const [state, formAction, pending] = useActionState(updateAttendanceAction, INITIAL_STATE);

  if (!actions.canClaim && !actions.canResolve && state.status === "idle") return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.canClaim && (
          <form action={formAction}>
            <input type="hidden" name="conversationId" value={conversationId} />
            <input type="hidden" name="operation" value="claim" />
            <button type="submit" disabled={pending} aria-busy={pending} className={buttonVariants({ size: "sm" })}>
              Assumir atendimento
            </button>
          </form>
        )}
        {actions.canResolve && (
          <form action={formAction}>
            <input type="hidden" name="conversationId" value={conversationId} />
            <input type="hidden" name="operation" value="resolve" />
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Resolver atendimento
            </button>
          </form>
        )}
      </div>
      <ActionFeedback state={state} />
    </div>
  );
}
