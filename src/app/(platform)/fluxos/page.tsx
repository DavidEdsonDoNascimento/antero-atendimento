import type { Metadata } from "next";

import { ComingSoon } from "@/components/ui/coming-soon";
import { IconFlows } from "@/components/ui/icons";
import { requireActiveContext } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Fluxos" };

export default async function FluxosPage() {
  await requireActiveContext();
  return (
    <ComingSoon
      title="Fluxos"
      description="Automação de atendimento com níveis e subníveis."
      cycle="Ciclo 3"
      icon={<IconFlows className="size-6" />}
      detail="A visualização e configuração básica dos fluxos de automação serão implementadas no Ciclo 3 — Automação."
    />
  );
}
