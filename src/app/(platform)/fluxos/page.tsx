import type { Metadata } from "next";

import { ComingSoon } from "@/components/ui/coming-soon";
import { IconFlows } from "@/components/ui/icons";
import { requireModule } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Automações" };

export default async function FluxosPage() {
  await requireModule("automacoes");
  return (
    <ComingSoon
      title="Automações"
      description="Fluxos, menus e respostas automáticas."
      cycle="recurso em desenvolvimento"
      icon={<IconFlows className="size-6" />}
      detail="Nenhuma automação está em execução: o editor e os fluxos ainda não estão disponíveis."
    />
  );
}
