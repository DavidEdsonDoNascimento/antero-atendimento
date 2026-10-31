/**
 * Erros de domínio das operações de módulos. Classes puras, como em
 * `modules/conversations/errors.ts`; a mensagem exibida sai do catálogo.
 */

/** A alteração quebraria a dependência entre módulos (SQLSTATE 23514 em `set_organization_module`). */
export class ModuleDependencyError extends Error {
  constructor() {
    super("A alteração quebraria a dependência entre módulos.");
    this.name = "ModuleDependencyError";
  }
}

export class OrganizationNotFoundError extends Error {
  constructor() {
    super("Organização não encontrada.");
    this.name = "OrganizationNotFoundError";
  }
}
