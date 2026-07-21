import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconShield } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { orgStatusLabel, orgStatusTone } from "@/lib/labels";
import { listAllOrganizations } from "@/modules/organizations/queries";

export const metadata: Metadata = { title: "Admin da plataforma" };

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "medium",
});

export default async function AdminPage() {
  await requirePlatformAdmin();
  const organizations = await listAllOrganizations();

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
                  <th className="px-5 py-3 font-medium">Criada em</th>
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
                    <td className="px-5 py-3 text-muted">
                      {dateFormatter.format(new Date(org.created_at))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-2">
        Criar, ativar e desativar organizações pela interface, além da situação
        das integrações, chega em uma etapa futura. Esta área é distinta do papel
        de proprietário de uma organização: o acesso é controlado pelo campo
        <code className="mx-1 text-gold-soft">is_platform_admin</code> e
        verificado no servidor.
      </p>
    </div>
  );
}
