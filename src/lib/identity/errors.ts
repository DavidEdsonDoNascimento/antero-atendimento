/**
 * Erros tipados da identidade (Better Auth). Nenhum carrega segredo, URL de
 * conexão, token, senha ou e-mail: só diagnóstico.
 *
 * Sem `import "server-only"` de propósito: classes puras (mesmo padrão de
 * `lib/db/errors.ts`).
 */

/** Configuração ausente/inválida (variáveis de ambiente, papel do banco, URL base). */
export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConfigError";
  }
}

/**
 * O serviço de identidade não respondeu (banco indisponível, erro interno).
 * Quem chama deve NEGAR o acesso — nunca tratar como "sessão válida".
 */
export class IdentityUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Serviço de identidade indisponível.", options);
    this.name = "IdentityUnavailableError";
  }
}

/** Provisionamento local recusado (alvo remoto, produção, dados inválidos). */
export class ProvisioningRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningRefusedError";
  }
}
