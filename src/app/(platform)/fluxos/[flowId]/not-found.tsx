import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconFlows } from "@/components/ui/icons";

export default function AutomacaoNaoEncontrada() {
  return (
    <EmptyState
      icon={<IconFlows className="size-6" />}
      title="Automação não encontrada"
      description="Ela não existe ou pertence a outra organização."
      action={
        <Link href="/fluxos" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          Ver automações
        </Link>
      }
    />
  );
}
