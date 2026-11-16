import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconShield } from "@/components/ui/icons";

export default function OrganizacaoNaoEncontrada() {
  return (
    <EmptyState
      icon={<IconShield className="size-6" />}
      title="Organização não encontrada"
      description="O endereço está incorreto ou a organização não existe mais."
      action={
        <Link href="/admin" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          Voltar às organizações
        </Link>
      }
    />
  );
}
