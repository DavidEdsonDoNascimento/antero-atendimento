import { SubmitButton } from "@/components/ui/submit-button";
import { setOrganizationStatusAction } from "@/modules/organizations/actions";
import type { Organization } from "@/lib/types/database";

/**
 * Suspender ou reativar uma organização (`setOrganizationStatusAction`, papel
 * conferido na ação e no banco). Suspender pede confirmação com o nome da
 * organização, para não suspender a errada.
 */
export function OrganizationStatusForm({ organization }: { organization: Pick<Organization, "id" | "name" | "status"> }) {
  if (organization.status === "active") {
    return (
      <details>
        <summary className="cursor-pointer text-muted">Suspender</summary>
        <form action={setOrganizationStatusAction} className="mt-2 space-y-2">
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
    );
  }
  return (
    <form action={setOrganizationStatusAction}>
      <input type="hidden" name="organizationId" value={organization.id} />
      <input type="hidden" name="status" value="active" />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Reativando…">
        Reativar
      </SubmitButton>
    </form>
  );
}
