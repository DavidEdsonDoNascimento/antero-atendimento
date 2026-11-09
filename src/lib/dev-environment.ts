// Puro (sem I/O) — sem `import "server-only"`: também decide se o atalho do
// simulador aparece na Inbox. No build de produção `process.env.NODE_ENV` é
// substituído por "production" e o resultado é sempre `false`.

/**
 * O simulador de mensagens (E2A) só existe em desenvolvimento (`next dev`) e nos
 * testes. Esta é a checagem de servidor da Server Action e da página; além
 * dela, a rota `/simulador` só é compilada no `next dev` (`pageExtensions` em
 * next.config.ts) e os arquivos do simulador ficam fora da imagem Docker
 * (.dockerignore).
 */
export function isSimulatorEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}
