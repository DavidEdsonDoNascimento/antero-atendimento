/**
 * Erros tipados da camada PostgreSQL. Nenhum carrega credencial, URL de
 * conexão, identificador de usuário ou dado de negócio: só diagnóstico.
 *
 * Erros do próprio PostgreSQL (`DatabaseError` do `pg`, com `code` SQLSTATE —
 * ex.: 42501 para permissão/RLS) NÃO são embrulhados: propagam como vieram,
 * para o chamador poder distinguir os casos.
 *
 * Sem `import "server-only"` de propósito: classes puras, sem I/O nem segredo
 * (mesmo padrão de `modules/conversations/errors.ts`).
 */

/** Configuração ausente/inválida ou credencial que não é a do `antero_app`. */
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

/**
 * Identificador de usuário ausente ou que não é um UUID. Mensagem sempre
 * genérica — nunca ecoa o valor recebido.
 */
export class InvalidUserContextError extends Error {
  constructor() {
    super("Contexto de usuário inválido: é necessário o UUID de uma sessão validada no servidor.");
    this.name = "InvalidUserContextError";
  }
}

/** Uso de uma transação depois de ela ter terminado (COMMIT/ROLLBACK). */
export class TransactionClosedError extends Error {
  constructor() {
    super("A transação já foi encerrada; use a transação apenas dentro do callback.");
    this.name = "TransactionClosedError";
  }
}

/**
 * Comando recusado pela camada antes de chegar ao banco: controle de
 * transação/sessão dentro do callback, ou parâmetro `Date` (perderia os
 * microssegundos — passe timestamps como string ISO).
 */
export class DisallowedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisallowedQueryError";
  }
}
