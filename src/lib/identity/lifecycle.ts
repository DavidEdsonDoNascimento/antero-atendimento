import "server-only";

// Ciclo de vida da identidade exposto ao resto da aplicação (health check e
// encerramento). A instância e o pool continuam fora do alcance (ver a regra
// de lint em eslint.config.mjs): aqui saem só estas duas operações.
export { closeIdentity, pingIdentityDatabase } from "./auth.ts";
