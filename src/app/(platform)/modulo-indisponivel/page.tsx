import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconShield } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveContext } from "@/lib/auth/dal";
import { MODULE_CATALOG, isOrganizationModule } from "@/modules/organizations/modules";

import { RefreshNavigation } from "./_components/refresh-navigation";

export const metadata: Metadata = { title: "Módulo indisponível" };

type ModuloIndisponivelPageProps = {
  searchParams: Promise<{ modulo?: string | string[] }>;
};

export default async function ModuloIndisponivelPage({ searchParams }: ModuloIndisponivelPageProps) {
  const { organization, modules } = await requireActiveContext();
  const { modulo } = await searchParams;
  // O parâmetro só escolhe o texto da tela; um valor fora do catálogo vira texto genérico.
  const requested = isOrganizationModule(modulo) ? modulo : null;
  if (requested && modules.includes(requested)) redirect(MODULE_CATALOG[requested].routes[0]);

  return (
    <div className="space-y-6">
      <PageHeader title="Módulo indisponível" />
      <RefreshNavigation />
      <EmptyState
        icon={<IconShield className="size-6" />}
        title={requested ? `${MODULE_CATALOG[requested].label} não está disponível` : "Recurso não disponível"}
        description={`Este recurso não está habilitado para ${organization.name}. Os dados da organização estão preservados. Para contratar ou habilitar, fale com o suporte da Antero Sistemas.`}
        action={
          <Link href="/visao-geral" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Ir para a visão geral
          </Link>
        }
      />
    </div>
  );
}
