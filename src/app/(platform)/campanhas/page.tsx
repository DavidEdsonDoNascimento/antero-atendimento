import type { Metadata } from "next";

import { ComingSoon } from "@/components/ui/coming-soon";
import { IconCampaigns } from "@/components/ui/icons";
import { requireModule } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Campanhas" };

export default async function CampanhasPage() {
  await requireModule("campanhas");
  return (
    <ComingSoon
      title="Campanhas"
      description="Criação e envio de campanhas."
      cycle="recurso em desenvolvimento"
      icon={<IconCampaigns className="size-6" />}
      detail="Nenhuma campanha pode ser criada ou enviada ainda: o envio não está disponível."
    />
  );
}
