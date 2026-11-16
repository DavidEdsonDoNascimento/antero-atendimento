"use client";

import { useActionState } from "react";

import { SubmitButton } from "@/components/ui/submit-button";
import { setOrganizationStatusAction } from "@/modules/organizations/actions";
import type { ModuleActionState } from "@/modules/organizations/modules";
import type { Organization } from "@/lib/types/database";

const INITIAL_STATE: ModuleActionState = { status: "idle" };

/**
 * Suspender ou reativar uma organização (`setOrganizationStatusAction`, papel
 * conferido na ação e no banco). Suspender pede confirmação com o nome da
 * organização, para não suspender a errada. Recusas e erros aparecem aqui, em
 * vez de levar à página de erro.
 */
export function OrganizationStatusForm({ organization }: { organization: Pick<Organization, "id" | "name" | "status"> }) {
  const [state, formAction] = useActionState(setOrganizationStatusAction, INITIAL_STATE);

  const feedback = state.status !== "idle" && (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={state.status === "error" ? "mt-1 max-w-xs text-xs text-red-300" : "mt-1 max-w-xs text-xs text-emerald-300"}
    >
      {state.message}
    </p>
  );

  if (organization.status === "active") {
    return (
      <div aria-live="polite">
        <details>
          <summary className="cursor-pointer text-muted">Suspender</summary>
          <form action={formAction} className="mt-2 space-y-2">
            <p className="max-w-xs text-xs text-muted">
              Suspender <strong className="font-medium text-foreground">{organization.name}</strong> bloqueia o acesso de
              todos os membros. Nada é apagado.
            </p>
            <input type="hidden" name="organizationId" value={organization.id} />
            <input type="hidden" name="status" value="inactive" />
            <SubmitButton variant="danger" size="sm" pendingLabel="Suspendendo…">
              Confirmar suspensão
            </SubmitButton>
          </form>
        </details>
        {feedback}
      </div>
    );
  }
  return (
    <div aria-live="polite">
      <form action={formAction}>
        <input type="hidden" name="organizationId" value={organization.id} />
        <input type="hidden" name="status" value="active" />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Reativando…">
          Reativar
        </SubmitButton>
      </form>
      {feedback}
    </div>
  );
}
