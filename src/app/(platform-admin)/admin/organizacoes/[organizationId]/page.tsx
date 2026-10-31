import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { orgStatusLabel, orgStatusTone } from "@/lib/labels";
import { getOrganizationModuleConfiguration } from "@/modules/organizations/sql-queries";

import { ModulePanel } from "./_components/module-panel";

export const metadata: Metadata = { title: "Módulos da organização" };

type OrganizationModulesPageProps = {
  params: Promise<{ organizationId: string }>;
};

export default async function OrganizationModulesPage({ params }: OrganizationModulesPageProps) {
  const profile = await requirePlatformAdmin();
  const { organizationId } = await params;
  if (!z.uuid().safeParse(organizationId).success) notFound();

  // O papel é conferido de novo no banco (`public.is_platform_admin`).
  const configuration = await getOrganizationModuleConfiguration({ userId: profile.id, organizationId });
  if (!configuration) notFound();
  const { organization, settings } = configuration;

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-muted hover:text-foreground">
        ← Voltar às organizações
      </Link>

      <PageHeader
        title={organization.name}
        description={`Módulos contratados por esta organização (${organization.slug}).`}
        actions={<Badge tone={orgStatusTone[organization.status]}>{orgStatusLabel[organization.status]}</Badge>}
      />

      {organization.status === "inactive" && (
        <Card>
          <CardContent className="text-sm text-muted">
            Organização suspensa: nenhum módulo opera enquanto ela estiver assim. A configuração abaixo fica salva e volta
            a valer quando ela for reativada.
          </CardContent>
        </Card>
      )}

      <ModulePanel organizationId={organization.id} organizationName={organization.name} settings={settings} />

      <p className="text-xs text-muted-2">
        A alteração vale na requisição seguinte de cada usuário da organização. Desabilitar um módulo não apaga dados.
      </p>
    </div>
  );
}
