import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconShield } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { orgStatusLabel, orgStatusTone } from "@/lib/labels";
import { setOrganizationStatusAction } from "@/modules/organizations/actions";
import { MODULE_CATALOG } from "@/modules/organizations/modules";
import {
  listAllOrganizations,
  listEnabledModules,
  type EnabledModuleRow,
} from "@/modules/organizations/sql-queries";

export const metadata: Metadata = { title: "Admin da plataforma" };

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "medium",
});

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

export default async function AdminPage() {
  const profile = await requirePlatformAdmin();
  // O papel é conferido de novo no banco (`public.is_platform_admin`).
  const [organizations, enabledModules] = await Promise.all([
    listAllOrganizations({ userId: profile.id }),
    listEnabledModules({ userId: profile.id }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin da plataforma"
        description="Administração interna da Antero — visão de todas as organizações."
      />

      {organizations.length === 0 ? (
        <EmptyState
          icon={<IconShield className="size-6" />}
          title="Nenhuma organização cadastrada"
          description="Cadastre a primeira organização seguindo docs/SETUP.md."
        />
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
                      {org.name}
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
                      {dateFormatter.format(new Date(org.created_at))}
                    </td>
                    <td className="space-y-2 px-5 py-3">
                      <Link
                        href={`/admin/organizacoes/${org.id}`}
                        className="block text-gold-soft hover:underline"
                      >
                        Configurar módulos
                      </Link>
                      {org.status === "active" ? (
                        <details>
                          <summary className="cursor-pointer text-muted">
                            Suspender
                          </summary>
                          <form action={setOrganizationStatusAction} className="mt-2">
                            <input type="hidden" name="organizationId" value={org.id} />
                            <input type="hidden" name="status" value="inactive" />
                            <SubmitButton variant="danger" size="sm" pendingLabel="Suspendendo…">
                              Confirmar suspensão
                            </SubmitButton>
                          </form>
                        </details>
                      ) : (
                        <form action={setOrganizationStatusAction}>
                          <input type="hidden" name="organizationId" value={org.id} />
                          <input type="hidden" name="status" value="active" />
                          <SubmitButton variant="secondary" size="sm" pendingLabel="Reativando…">
                            Reativar
                          </SubmitButton>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-2">
        Suspender uma organização bloqueia o acesso dos membros sem apagar dados;
        reativar restaura as permissões e os módulos. Criar organizações e a situação das
        integrações chegam em uma etapa futura. Esta área é distinta do papel
        de proprietário de uma organização: o acesso é controlado pelo campo
        <code className="mx-1 text-gold-soft">is_platform_admin</code> e
        verificado no servidor.
      </p>
    </div>
  );
}
