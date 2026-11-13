// Limites das mensagens do WhatsApp Cloud API que um fluxo precisa respeitar
// para poder ser enviado sem adaptação (E3C). Lógica pura, sem I/O.
// Fonte: documentação de mensagens da Cloud API (texto, imagem, lista interativa).

export const WHATSAPP_LIMITS = {
  textBody: 4096,
  imageCaption: 1024,
  imageUrl: 2000,
  listBody: 1024,
  listHeader: 60,
  listFooter: 60,
  listButton: 20,
  listSectionTitle: 24,
  /** Linhas no total, somando todas as seções. */
  listRows: 10,
  listRowId: 200,
  listRowTitle: 24,
  listRowDescription: 72,
} as const;

/** Limites do próprio motor (proteção contra loops e respostas em excesso). */
export const ENGINE_LIMITS = {
  /** Etapas percorridas sem esperar o cliente, numa única resposta. */
  autoStepsPerTurn: 20,
  /** Mensagens enviadas numa única resposta. */
  outputsPerTurn: 6,
  /** Profundidade guardada para "voltar ao menu anterior". */
  menuStack: 20,
  steps: 200,
} as const;
