import { Suspense } from "react";

import { activityHref, type ParsedActivitySearch } from "@/modules/audit/search-params";

import { ActivityFilters, type ActivityOrganizationOption } from "./activity-filters";
import { ActivityList, ActivityListSkeleton } from "./activity-list";

/**
 * Histórico de atividades administrativas, o mesmo nas duas rotas
 * (`/admin/atividades` e `/admin/organizacoes/[id]/atividades`): filtros,
 * aviso de período inválido e a lista. Só leitura: nenhum formulário POST.
 * A página chama isto depois de `requirePlatformAdmin()` e, na rota da
 * organização, depois do `notFound()`.
 */
export function ActivityHistory({
  userId,
  basePath,
  search,
  scope,
  organizations,
}: {
  userId: string;
  basePath: string;
  search: ParsedActivitySearch;
  scope?: { organizationId: string };
  /** Só na visão global: filtro por organização e coluna de organização na lista. */
  organizations?: ActivityOrganizationOption[];
}) {
  return (
    <div className="space-y-4">
      <ActivityFilters basePath={basePath} filters={search.filters} periodInput={search.periodInput} organizations={organizations} />
      {search.periodInvalid && (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
          Período inválido: confira as datas (a data inicial não pode ser posterior à final). O filtro de período foi
          ignorado; os demais filtros continuam valendo.
        </p>
      )}
      <Suspense key={activityHref(basePath, search.filters, search.cursor)} fallback={<ActivityListSkeleton />}>
        <ActivityList
          userId={userId}
          basePath={basePath}
          filters={search.filters}
          scope={scope}
          cursor={search.cursor}
          showOrganization={organizations !== undefined}
        />
      </Suspense>
    </div>
  );
}
