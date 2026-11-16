import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { orgStatusLabel } from "@/lib/labels";
import type { OrganizationStatus } from "@/lib/types/database";
import { organizationsHref } from "@/modules/organizations/search";
import { cn } from "@/lib/utils/cn";

const STATUS_OPTIONS: Array<OrganizationStatus | undefined> = [undefined, "active", "inactive"];

/**
 * Busca e filtro por situação da lista de organizações. Tudo na URL e sem JS:
 * a busca é um formulário GET e as situações são links, então a página pode ser
 * recarregada, compartilhada e voltada pelo navegador.
 */
export function OrganizationFilters({ search, status }: { search?: string; status?: OrganizationStatus }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <form action="/admin" method="get" role="search" className="flex w-full gap-2 sm:max-w-md">
        {status && <input type="hidden" name="situacao" value={status} />}
        <Input
          type="search"
          name="busca"
          defaultValue={search ?? ""}
          maxLength={80}
          placeholder="Buscar por nome ou identificador"
          aria-label="Buscar organização por nome ou identificador"
        />
        <button type="submit" className={buttonVariants({ variant: "secondary", size: "md" })}>
          Buscar
        </button>
      </form>
      <div role="group" aria-label="Filtrar por situação" className="flex flex-wrap gap-1.5">
        {STATUS_OPTIONS.map((option) => {
          const active = option === status;
          return (
            <Link
              key={option ?? "all"}
              href={organizationsHref({ search, status: option })}
              aria-current={active ? "true" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-gold/40 bg-gold/10 text-gold-soft"
                  : "border-line text-muted hover:border-line-strong hover:text-foreground",
              )}
            >
              {option ? `${orgStatusLabel[option]}s` : "Todas"}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
