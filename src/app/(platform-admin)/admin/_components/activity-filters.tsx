import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { auditActionLabel } from "@/lib/labels";
import { cn } from "@/lib/utils/cn";
import { AUDIT_ACTIONS } from "@/modules/audit/catalog";
import type { ActivityFilters as Filters } from "@/modules/audit/search-params";

const SELECT_CLASS = cn(
  "w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-foreground",
  "outline-none transition-colors focus-visible:border-gold/50 focus-visible:ring-2 focus-visible:ring-gold/30",
);

export type ActivityOrganizationOption = { id: string; name: string };

/**
 * Filtros do histórico de atividades, como `OrganizationFilters`: formulário
 * GET sem JS, tudo na URL. O formulário não envia o cursor (`antes`), então
 * mudar qualquer filtro volta aos eventos mais recentes.
 */
export function ActivityFilters({
  basePath,
  filters,
  periodInput,
  organizations,
}: {
  basePath: string;
  filters: Filters;
  periodInput: { from?: string; to?: string };
  /** Só na visão global: habilita o filtro por organização. */
  organizations?: ActivityOrganizationOption[];
}) {
  const selectedMissing =
    organizations && filters.organizationId && !organizations.some((organization) => organization.id === filters.organizationId);

  return (
    <form
      action={basePath}
      method="get"
      role="search"
      aria-label="Filtrar atividades"
      className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] lg:items-end"
    >
      <Field label="Tipo de operação" htmlFor="atividade-tipo">
        <select id="atividade-tipo" name="tipo" defaultValue={filters.action ?? ""} className={SELECT_CLASS}>
          <option value="">Todas</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {auditActionLabel[action]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="De" htmlFor="atividade-de">
        <Input id="atividade-de" type="date" name="de" min="2000-01-01" max="2100-12-31" defaultValue={periodInput.from ?? ""} />
      </Field>
      <Field label="Até" htmlFor="atividade-ate">
        <Input id="atividade-ate" type="date" name="ate" min="2000-01-01" max="2100-12-31" defaultValue={periodInput.to ?? ""} />
      </Field>
      {organizations && (
        <Field label="Organização" htmlFor="atividade-organizacao">
          <select id="atividade-organizacao" name="organizacao" defaultValue={filters.organizationId ?? ""} className={SELECT_CLASS}>
            <option value="">Todas</option>
            {selectedMissing && (
              <option value={filters.organizationId}>Organização excluída · {filters.organizationId!.slice(0, 8)}</option>
            )}
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="flex items-center gap-2 whitespace-nowrap sm:col-span-2 lg:col-span-1">
        <button type="submit" className={buttonVariants({ variant: "secondary", size: "md" })}>
          Filtrar
        </button>
        <Link href={basePath} className={buttonVariants({ variant: "ghost", size: "md" })}>
          Limpar filtros
        </Link>
      </div>
    </form>
  );
}
