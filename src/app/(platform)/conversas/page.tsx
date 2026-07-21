import type { Metadata } from "next";

import { ComingSoon } from "@/components/ui/coming-soon";
import { IconConversations } from "@/components/ui/icons";
import { requireActiveContext } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Conversas" };

export default async function ConversasPage() {
  await requireActiveContext();
  return (
    <ComingSoon
      title="Conversas"
      description="Caixa de entrada de atendimento."
      cycle="Ciclo 2"
      icon={<IconConversations className="size-6" />}
      detail="A caixa de entrada, o histórico de mensagens e o envio de respostas simuladas serão implementados no Ciclo 2 — Atendimento simulado."
    />
  );
}
