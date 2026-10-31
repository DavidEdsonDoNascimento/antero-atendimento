"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * O layout não roda de novo na navegação pelo cliente: quem chega aqui por um
 * link antigo do menu ainda vê o módulo desligado. Atualiza o menu da aba aberta.
 */
export function RefreshNavigation() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}
