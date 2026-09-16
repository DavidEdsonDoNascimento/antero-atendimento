// Lógica pura (sem I/O, sem segredo) — sem `import "server-only"` de
// propósito, para permanecer testável com `node --test` sem flags
// especiais. O limite server-side real está em `queries.ts`, que é quem
// toca o cliente Supabase/cookies e importa este módulo.
export type PageLimitConfig = {
  default: number;
  max: number;
};

/** Lista paginada de conversas (caixa de entrada). */
export const CONVERSATIONS_PAGE_LIMIT: PageLimitConfig = { default: 20, max: 50 };

/** Histórico paginado de mensagens de uma conversa. */
export const MESSAGES_PAGE_LIMIT: PageLimitConfig = { default: 50, max: 100 };

/**
 * Normaliza o limite de página pedido pelo chamador: usa o padrão quando
 * omitido ou inválido (não inteiro, zero, negativo) e nunca ultrapassa o
 * teto de segurança da consulta.
 */
export function clampLimit(
  requested: number | undefined,
  config: PageLimitConfig,
): number {
  if (requested === undefined || !Number.isInteger(requested) || requested <= 0) {
    return config.default;
  }
  return Math.min(requested, config.max);
}
