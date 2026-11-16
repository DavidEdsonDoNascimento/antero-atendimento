import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";
import { IconShield } from "@/components/ui/icons";

export function AdminOnly() {
  return (
    <div className="space-y-6">
      <Link href="/fluxos" className="text-xs text-muted hover:text-foreground">
        ← Automações
      </Link>
      <EmptyState
        icon={<IconShield className="size-6" />}
        title="Só proprietários e administradores editam automações"
        description="Peça a um administrador da sua organização para fazer a alteração."
      />
    </div>
  );
}
