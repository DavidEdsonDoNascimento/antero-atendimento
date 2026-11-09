import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { isSimulatorEnabled } from "@/lib/dev-environment";

/**
 * Atalho para o simulador de mensagens, só em desenvolvimento e testes. Esconder
 * o link não é a proteção: a rota nem existe no build de produção e a ação recusa
 * fora desses ambientes (ver `lib/dev-environment.ts`).
 */
export function SimulatorLink() {
  if (!isSimulatorEnabled()) return null;
  return (
    <Link href="/simulador" className={buttonVariants({ variant: "secondary", size: "sm" })}>
      Simulador (dev)
    </Link>
  );
}
