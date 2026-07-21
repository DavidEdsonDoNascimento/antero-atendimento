import type { Metadata } from "next";

import { ComingSoon } from "@/components/ui/coming-soon";
import { IconContacts } from "@/components/ui/icons";
import { requireActiveContext } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Contatos" };

export default async function ContatosPage() {
  await requireActiveContext();
  return (
    <ComingSoon
      title="Contatos"
      description="Pessoas que entraram em contato com a organização."
      cycle="Ciclo 2"
      icon={<IconContacts className="size-6" />}
      detail="A listagem de contatos, informações básicas e histórico de conversas serão implementados no Ciclo 2 — Atendimento simulado."
    />
  );
}
