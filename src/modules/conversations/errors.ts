/**
 * Erros tipados da DAL de leitura de conversas — permitem ao chamador
 * diferenciar falha de consulta de cursor inválido, em vez de um `catch`
 * genérico. Nenhum dos dois carrega conteúdo de mensagem, telefone ou outro
 * dado sensível: apenas texto de diagnóstico de infraestrutura/consulta.
 *
 * Sem `import "server-only"` de propósito: classes de erro puras, sem I/O,
 * sem segredo — o limite server-side real está em `queries.ts`.
 */

/**
 * Falha ao executar uma consulta na DAL de conversas (erro do
 * Postgrest/Supabase — sintaxe de consulta, permissão, conectividade).
 * Não é usada para "não encontrado": isso é modelado retornando `null`.
 */
export class ConversationQueryError extends Error {
  constructor(message: string) {
    super(message);
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
