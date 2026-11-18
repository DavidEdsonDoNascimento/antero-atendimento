import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconShield } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { orgStatusLabel, orgStatusTone } from "@/lib/labels";
import { MODULE_CATALOG } from "@/modules/organizations/modules";
import { organizationsHref, parseOrganizationSearch, parseOrganizationStatusFilter } from "@/modules/organizations/search";
import {
  listAllOrganizations,
  listEnabledModules,
  type EnabledModuleRow,
} from "@/modules/organizations/sql-queries";

import { OrganizationFilters } from "./_components/organization-filters";
import { OrganizationStatusForm } from "./_components/organization-status-form";
import { formatDate } from "./_lib/format";

export const metadata: Metadata = { title: "Admin da plataforma" };

type AdminPageProps = {
  searchParams: Promise<{ busca?: string | string[]; situacao?: string | string[] }>;
};

function EnabledModules({ modules }: { modules: EnabledModuleRow[] }) {
  if (modules.length === 0) return <span className="text-muted-2">Nenhum</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {modules.map(({ module }) => (
        <Badge key={module} tone="gold">
          {MODULE_CATALOG[module].label}
        </Badge>
      ))}
    </div>
  );
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const profile = await requirePlatformAdmin();
  const sp = await searchParams;
  const search = parseOrganizationSearch(sp.busca);
  const status = parseOrganizationStatusFilter(sp.situacao);
  const filtered = search !== undefined || status !== undefined;
  // O papel é conferido de novo no banco (`public.is_platform_admin`).
  const [organizations, enabledModules] = await Promise.all([
    listAllOrganizations({ userId: profile.id }, { search, status }),
    listEnabledModules({ userId: profile.id }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizações"
        description="Administração interna da Antero: clientes, situação e módulos contratados. Abra uma organização para ver a equipe e o canal."
      />

      <OrganizationFilters search={search} status={status} />

      {organizations.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={<IconShield className="size-6" />}
            title="Nenhuma organização encontrada"
            description="Nenhuma organização combina com a busca e a situação escolhidas."
            action={
              <Link href={organizationsHref()} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Limpar filtros
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={<IconShield className="size-6" />}
            title="Nenhuma organização cadastrada"
            description="Cadastre a primeira organização seguindo docs/SETUP.md."
          />
        )
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted-2">
                  <th className="px-5 py-3 font-medium">Organização</th>
                  <th className="px-5 py-3 font-medium">Identificador</th>
                  <th className="px-5 py-3 font-medium">Situação</th>
                  <th className="px-5 py-3 font-medium">Módulos habilitados</th>
                  <th className="px-5 py-3 font-medium">Criada em</th>
                  <th className="px-5 py-3 font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {organizations.map((org) => (
                  <tr key={org.id} className="hover:bg-surface-2/50">
                    <td className="px-5 py-3 font-medium text-foreground">
                      <Link href={`/admin/organizacoes/${org.id}`} className="hover:text-gold-soft hover:underline">
                        {org.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-muted">{org.slug}</td>
                    <td className="px-5 py-3">
                      <Badge tone={orgStatusTone[org.status]}>
                        {orgStatusLabel[org.status]}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <EnabledModules
                        modules={enabledModules.filter((row) => row.organization_id === org.id)}
                      />
                    </td>
                    <td className="px-5 py-3 text-muted">
                      {formatDate(org.created_at)}
                    </td>
                    <td className="space-y-2 px-5 py-3">
                      <Link
                        href={`/admin/organizacoes/${org.id}`}
                        className="block text-gold-soft hover:underline"
                      >
                        Abrir detalhes
                      </Link>
                      <OrganizationStatusForm organization={org} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-2">
        {organizations.length > 0 &&
          `${organizations.length} ${organizations.length === 1 ? "organização" : "organizações"}${filtered ? " encontrada(s)" : ""}. `}
        Suspender uma organização bloqueia o acesso dos membros sem apagar dados; reativar restaura as permissões e os
        módulos. Esta área é só de administração: conversas, contatos e dados dos clientes finais não aparecem aqui.
      </p>
    </div>
  );
}
