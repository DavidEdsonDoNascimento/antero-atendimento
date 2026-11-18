import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requirePlatformAdmin } from "@/lib/auth/dal";
import { orgStatusLabel, orgStatusTone } from "@/lib/labels";
import { getOrganizationAdminDetails, getOrganizationModuleConfiguration } from "@/modules/organizations/sql-queries";

import { OrganizationStatusForm } from "../../_components/organization-status-form";
import { ModulePanel } from "./_components/module-panel";
import { OrganizationChannels, OrganizationSummary, OrganizationTeam } from "./_components/organization-info";

export const metadata: Metadata = { title: "Organização" };

type OrganizationPageProps = {
  params: Promise<{ organizationId: string }>;
};

/**
 * Central da organização para o admin da plataforma: dados cadastrais, situação,
 * módulos, equipe e canal. É só administração: abrir esta página não cria
 * vínculo, não troca a organização ativa de ninguém e não alcança conversas,
 * contatos nem automações (que exigem vínculo na própria organização).
 */
export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const profile = await requirePlatformAdmin();
  const { organizationId } = await params;
  if (!z.uuid().safeParse(organizationId).success) notFound();

  // O papel é conferido de novo no banco (`public.is_platform_admin`), em cada consulta.
  const context = { userId: profile.id, organizationId };
  const [configuration, details] = await Promise.all([
    getOrganizationModuleConfiguration(context),
    getOrganizationAdminDetails(context),
  ]);
  if (!configuration || !details) notFound();
  const { organization, settings } = configuration;

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-muted hover:text-foreground">
        ← Voltar às organizações
      </Link>

      <PageHeader
        title={organization.name}
        description={`Administração da plataforma · ${organization.slug}`}
        actions={<Badge tone={orgStatusTone[organization.status]}>{orgStatusLabel[organization.status]}</Badge>}
      />

      <p className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm text-sky-100">
        Você está consultando <strong className="font-medium">{organization.name}</strong> como administrador da
        plataforma. Aqui ficam os dados cadastrais, os módulos, a equipe e o canal. Conversas, contatos e automações da
        organização não são acessíveis por esta área; a edição de automações pelo suporte da Antero será disponibilizada em
        uma entrega futura.
      </p>

      {organization.status === "inactive" && (
        <Card>
          <CardContent className="text-sm text-muted">
            Organização suspensa: nenhum módulo opera enquanto ela estiver assim. A configuração abaixo fica salva e volta
            a valer quando ela for reativada.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <OrganizationSummary organization={organization} />
        <Card>
          <CardContent className="space-y-3 text-sm">
            <h2 className="text-sm font-semibold text-foreground">Situação da organização</h2>
            <p className="text-muted">
              Suspender bloqueia o acesso de todos os membros, sem apagar dados. Reativar restaura o acesso e os módulos como
              estavam.
            </p>
            <OrganizationStatusForm organization={organization} />
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="modulos" className="space-y-3">
        <h2 id="modulos" className="text-sm font-semibold text-foreground">
          Módulos contratados
        </h2>
        <ModulePanel organizationId={organization.id} organizationName={organization.name} settings={settings} />
        <p className="text-xs text-muted-2">
          A alteração vale na requisição seguinte de cada usuário da organização. Desabilitar um módulo não apaga dados.
        </p>
      </section>

      <Card>
        <CardContent className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Atividades administrativas</h2>
            <p className="text-muted">
              Suspensões, reativações e alterações de módulos desta organização, com responsável e horário.
            </p>
          </div>
          <Link
            href={`/admin/organizacoes/${organization.id}/atividades`}
            className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
          >
            Ver histórico
          </Link>
        </CardContent>
      </Card>

      <OrganizationTeam members={details.members} />
      <OrganizationChannels channels={details.channels} />
    </div>
  );
}
