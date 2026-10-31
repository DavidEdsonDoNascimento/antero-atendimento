import type { Metadata } from "next";

import { ComingSoon } from "@/components/ui/coming-soon";
import { IconContacts } from "@/components/ui/icons";
import { requireModule } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Contatos" };

export default async function ContatosPage() {
  await requireModule("contatos");
  return (
    <ComingSoon
      title="Contatos"
      description="Gestão, importação e listas de contatos da organização."
      cycle="recurso em desenvolvimento"
      icon={<IconContacts className="size-6" />}
      detail="A gestão, a importação e as listas de contatos ainda não estão disponíveis."
    />
  );
}
