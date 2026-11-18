import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageHeader } from "@/components/ui/page-header";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { parseActivitySearchParams, type ActivitySearchParams } from "@/modules/audit/search-params";
import { getOrganizationModuleConfiguration } from "@/modules/organizations/sql-queries";

import { ActivityHistory } from "../../../_components/activity-history";

export const metadata: Metadata = { title: "Atividades administrativas" };

type OrganizationActivityPageProps = {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<ActivitySearchParams>;
};

/**
 * Histórico de atividades administrativas de uma organização — só admin da
 * plataforma. Autorização e existência da organização ANTES de qualquer
 * conteúdo transmitido: id inválido ou inexistente responde 404 (a lista fica
 * num `<Suspense>` depois disso, sem `loading.tsx`).
 */
export default async function OrganizationActivityPage({ params, searchParams }: OrganizationActivityPageProps) {
  const profile = await requirePlatformAdmin();
  const { organizationId } = await params;
  if (!z.uuid().safeParse(organizationId).success) notFound();

  // O papel é conferido de novo no banco (`public.is_platform_admin`), em cada consulta.
  const configuration = await getOrganizationModuleConfiguration({ userId: profile.id, organizationId });
  if (!configuration) notFound();
  const { organization } = configuration;
  const search = parseActivitySearchParams(await searchParams, { withOrganization: false });

  return (
    <div className="space-y-6">
      <Link href={`/admin/organizacoes/${organization.id}`} className="text-sm text-muted hover:text-foreground">
        ← Voltar a {organization.name}
      </Link>

      <PageHeader
        title="Atividades administrativas"
        description={`${organization.name} · ${organization.slug} · Horários de Brasília`}
      />

      <ActivityHistory
        userId={profile.id}
        basePath={`/admin/organizacoes/${organization.id}/atividades`}
        search={search}
        scope={{ organizationId: organization.id }}
      />

      <p className="text-xs text-muted-2">
        Alterações administrativas efetivadas nesta organização, mais recentes primeiro. O histórico é só de leitura:
        eventos não podem ser alterados nem apagados.
      </p>
    </div>
  );
}
