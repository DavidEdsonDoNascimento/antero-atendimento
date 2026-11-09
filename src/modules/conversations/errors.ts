import type { AttendanceErrorCode } from "./attendance";

/**
 * Erros tipados da DAL de leitura de conversas — permitem ao chamador
 * diferenciar falha de consulta de cursor inválido, em vez de um `catch`
 * genérico. Nenhum dos dois carrega conteúdo de mensagem, telefone ou outro
 * dado sensível: apenas texto de diagnóstico de infraestrutura/consulta.
 *
 * Sem `import "server-only"` de propósito: classes de erro puras, sem I/O,
 * sem segredo — o limite server-side real está em `sql-queries.ts`.
 */

/**
 * Falha ao executar uma consulta na DAL de conversas (erro do
 * PostgreSQL — sintaxe de consulta, permissão,
 * conectividade).
 * Não é usada para "não encontrado": isso é modelado retornando `null`.
 */
export class ConversationQueryError extends Error {
  /** `options.cause`: erro original (ex.: `DatabaseError` com SQLSTATE), só para diagnóstico no servidor. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationQueryError";
  }
}

/**
 * Cursor de paginação malformado, adulterado ou de um formato incompatível.
 * Mensagem sempre genérica — nunca ecoa o motivo interno do parsing/validação.
 */
export class InvalidCursorError extends Error {
  constructor() {
    super("Cursor de paginação inválido.");
    this.name = "InvalidCursorError";
  }
}

/**
 * Operação de atendimento recusada pelo banco (assumir, responder, resolver).
 * `code` é o motivo de negócio — a tela escolhe a mensagem por ele
 * (`attendanceErrorMessage` em `attendance.ts`); nada do conteúdo da mensagem
 * ou do contato entra aqui.
 */
export class AttendanceActionError extends Error {
  readonly code: AttendanceErrorCode;

  constructor(code: AttendanceErrorCode, options?: ErrorOptions) {
    super(`Operação de atendimento recusada: ${code}.`, options);
    this.name = "AttendanceActionError";
    this.code = code;
  }
}
