/**
 * Erros da leitura da auditoria administrativa. Classes puras, como em
 * `modules/conversations/errors.ts`; nenhuma ecoa o valor recebido.
 */

/** Cursor de paginação malformado, adulterado ou fora do intervalo aceito pelo PostgreSQL. */
export class InvalidAuditCursorError extends Error {
  constructor() {
    super("Cursor de paginação inválido.");
    this.name = "InvalidAuditCursorError";
  }
}

/** Filtro que não passou pela validação de `search-params.ts` (erro de programação, nunca da URL). */
export class InvalidAuditFilterError extends Error {
  constructor() {
    super("Filtro de auditoria inválido.");
    this.name = "InvalidAuditFilterError";
  }
}
