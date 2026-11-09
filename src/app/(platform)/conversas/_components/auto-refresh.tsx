"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Atualização simples da Inbox (sem WebSocket nesta entrega): de tempos em
 * tempos, com a aba visível, pede ao servidor a lista e o detalhe de novo. O
 * estado dos componentes de cliente (texto sendo escrito) é preservado.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
