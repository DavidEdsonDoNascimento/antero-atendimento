/**
 * Executado uma vez por processo do servidor Next.js. Em produção liga o
 * encerramento controlado (SIGTERM/SIGINT) ao fechamento dos pools do
 * PostgreSQL — ver `lib/shutdown.ts`. Em desenvolvimento o Next já cuida do
 * encerramento e nada é registrado.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;

  const [{ installGracefulShutdown }, { closeAppPool }, { closeIdentity }] = await Promise.all([
    import("./lib/shutdown"),
    import("./lib/db"),
    import("./lib/identity/lifecycle"),
  ]);
  installGracefulShutdown({
    close: async () => {
      await Promise.all([closeAppPool(), closeIdentity()]);
    },
  });
}
