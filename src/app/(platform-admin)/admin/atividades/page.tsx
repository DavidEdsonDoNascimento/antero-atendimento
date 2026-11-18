import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui/page-header";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { parseActivitySearchParams, type ActivitySearchParams } from "@/modules/audit/search-params";
import { listAllOrganizations } from "@/modules/organizations/sql-queries";

import { ActivityHistory } from "../_components/activity-history";

export const metadata: Metadata = { title: "Atividades administrativas" };

type ActivityPageProps = {
  searchParams: Promise<ActivitySearchParams>;
};

/**
 * Histórico de atividades administrativas de todas as organizações — só admin
 * da plataforma. Única tela que mostra eventos de organizações excluídas
 * (o evento sobrevive à exclusão; o nome não).
 */
export default async function ActivityPage({ searchParams }: ActivityPageProps) {
  const profile = await requirePlatformAdmin();
  const search = parseActivitySearchParams(await searchParams, { withOrganization: true });
  // O papel é conferido de novo no banco (`public.is_platform_admin`), em cada consulta.
  const organizations = await listAllOrganizations({ userId: profile.id });

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-muted hover:text-foreground">
        ← Voltar às organizações
      </Link>

      <PageHeader title="Atividades administrativas" description="Todas as organizações · Horários de Brasília" />

      <ActivityHistory
        userId={profile.id}
        basePath="/admin/atividades"
        search={search}
        organizations={organizations.map(({ id, name }) => ({ id, name }))}
      />

      <p className="text-xs text-muted-2">
        Alterações administrativas efetivadas, mais recentes primeiro, inclusive de organizações que já foram excluídas.
        O histórico é só de leitura: eventos não podem ser alterados nem apagados.
      </p>
    </div>
  );
}
