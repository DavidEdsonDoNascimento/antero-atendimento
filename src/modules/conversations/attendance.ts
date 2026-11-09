import type { ConversationStatus, MemberRole } from "../../lib/types/database";

// Lógica pura (sem I/O) — sem `import "server-only"`, testável com `node --test`.
// A tela usa estas regras só para orientar o atendente; quem decide é o banco
// (funções de 0008), com o relógio do banco.

/** Janela de atendimento: respostas livres até 24 h depois da última mensagem RECEBIDA do cliente. */
export const REPLY_WINDOW_HOURS = 24;
const REPLY_WINDOW_MS = REPLY_WINDOW_HOURS * 60 * 60 * 1000;

export type ReplyWindow =
  | { open: true; closesAt: string }
  | { open: false; closedAt: string | null };

/** Situação da janela; `closedAt` nulo quando o cliente ainda não enviou nada. */
export function replyWindowOf(lastInboundAt: string | null, now: Date = new Date()): ReplyWindow {
  if (!lastInboundAt) return { open: false, closedAt: null };
  const closes = new Date(new Date(lastInboundAt).getTime() + REPLY_WINDOW_MS);
  return closes.getTime() > now.getTime()
    ? { open: true, closesAt: closes.toISOString() }
    : { open: false, closedAt: closes.toISOString() };
}

export type AttendanceViewer = { userId: string; role: MemberRole };

export type AttendanceActions = {
  canClaim: boolean;
  canResolve: boolean;
  canReply: boolean;
  /** A conversa está com o próprio usuário. */
  isMine: boolean;
};

/** Mesmas regras de claim/resolve/send_conversation_reply (0008), para mostrar só o que o banco aceitaria. */
export function attendanceActionsFor(
  conversation: { status: ConversationStatus; assigneeUserId: string | null },
  viewer: AttendanceViewer,
): AttendanceActions {
  const isMine = conversation.assigneeUserId === viewer.userId;
  const freeOrMine = conversation.assigneeUserId === null || isMine;
  const human = conversation.status === "human";
  return {
    canClaim: (conversation.status === "waiting" || conversation.status === "bot") && freeOrMine,
    canResolve: human && (isMine || viewer.role === "owner" || viewer.role === "admin"),
    canReply: human && isMine,
    isMine,
  };
}

/**
 * Motivos de recusa das operações de atendimento. Cada um corresponde a um
 * SQLSTATE das funções de 0008 (ver `attendanceErrorCodeOf`).
 */
export type AttendanceErrorCode =
  | "access_denied"
  | "not_found"
  | "assigned_to_other"
  | "not_eligible"
  | "not_assignee"
  | "window_closed"
  | "invalid_content"
  | "idempotency_conflict"
  | "channel_unavailable"
  | "provider_unavailable";

const SQLSTATE_CODES: Record<string, AttendanceErrorCode> = {
  "28000": "access_denied",
  "42501": "access_denied",
  P0002: "not_found",
  AT001: "assigned_to_other",
  AT002: "not_eligible",
  AT003: "not_assignee",
  AT004: "window_closed",
  AT005: "invalid_content",
  AT006: "idempotency_conflict",
  AT007: "channel_unavailable",
  AT008: "provider_unavailable",
};

/** Motivo para um SQLSTATE das funções de atendimento, ou `undefined` se não for um deles. */
export function attendanceErrorCodeOf(sqlState: string | undefined): AttendanceErrorCode | undefined {
  return sqlState === undefined ? undefined : SQLSTATE_CODES[sqlState];
}

export const attendanceErrorMessage: Record<AttendanceErrorCode, string> = {
  access_denied: "Você não tem acesso ao Atendimento desta organização.",
  not_found: "Conversa não encontrada.",
  assigned_to_other: "Outro atendente já assumiu esta conversa.",
  not_eligible: "A conversa mudou de situação. Atualize a página para ver o estado atual.",
  not_assignee: "Só o atendente responsável pode fazer isso.",
  window_closed:
    "A janela de 24 horas para respostas livres está encerrada. Aguarde uma nova mensagem do cliente.",
  invalid_content: "Escreva uma mensagem de até 4096 caracteres.",
  idempotency_conflict: "Não foi possível enviar. Recarregue a página e tente novamente.",
  channel_unavailable: "O canal desta conversa está desconectado.",
  provider_unavailable: "O envio por este canal ainda não está disponível.",
};
