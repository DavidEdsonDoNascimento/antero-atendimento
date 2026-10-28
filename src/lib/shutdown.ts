// Encerramento controlado do processo (SIGTERM/SIGINT) — lógica pura, sem
// `server-only`, para ser testável com `node --test`. Quem a liga ao banco é
// `src/instrumentation.ts`.
//
// O Next.js já trata SIGTERM/SIGINT por conta própria (start-server): para de
// aceitar conexões, espera as requisições em andamento terminarem e só então
// chama `process.exit(143|130)`. Ele NÃO conhece os pools do PostgreSQL, e
// não há gancho público depois do drain. Por isso:
//
//   1. o sinal só marca "encerrando" (a prontidão passa a responder 503);
//   2. a primeira chamada a `process.exit` DEPOIS do sinal — que é o fim do
//      drain do Next — espera os pools fecharem (com limite de tempo) e então
//      sai com o MESMO código. Antes de um sinal `process.exit` fica intacto;
//   3. se o drain demorar demais, fecha os pools e sai por conta própria.
//
// Não cria um segundo handler de saída, não repete `exit` e ignora sinais
// duplicados (Ctrl+C em shell interativo envia SIGINT mais de uma vez).

export type ShutdownTarget = {
  once(event: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
  exit: (code?: number) => never;
};

export type ShutdownOptions = {
  target?: ShutdownTarget;
  /** Fecha os recursos (pools). Deve ser idempotente; falhas são registradas. */
  close: () => Promise<void>;
  /** Tempo máximo para os pools fecharem (ms). */
  closeTimeoutMs?: number;
  /** Se o drain do Next passar disso, encerra à força (ms). Menor que o `stop_grace_period`. */
  forceAfterMs?: number;
  log?: (message: string) => void;
};

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_AFTER_MS = 20_000;
const EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

// Estado em `globalThis`: o Next compila `instrumentation.ts` e as rotas em
// bundles separados, e cada um teria a sua cópia deste módulo.
const INSTALLED_KEY = "__anteroShutdownInstalled";
const SHUTTING_DOWN_KEY = "__anteroShuttingDown";
const holder = globalThis as typeof globalThis & { [INSTALLED_KEY]?: boolean; [SHUTTING_DOWN_KEY]?: boolean };

/** Verdadeiro depois de SIGTERM/SIGINT: a prontidão deve responder 503. */
export function isShuttingDown(): boolean {
  return holder[SHUTTING_DOWN_KEY] === true;
}

/** Uso em testes. */
export function resetShutdownStateForTests(): void {
  holder[SHUTTING_DOWN_KEY] = false;
}

export function installGracefulShutdown(options: ShutdownOptions): void {
  const target = options.target ?? (process as unknown as ShutdownTarget);
  // `register()` pode rodar mais de uma vez no mesmo processo; só um handler.
  if (options.target === undefined) {
    if (holder[INSTALLED_KEY]) return;
    holder[INSTALLED_KEY] = true;
  }
  const log = options.log ?? ((message: string) => console.log(`[shutdown] ${message}`));
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const forceAfterMs = options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS;
  const originalExit = target.exit.bind(target);

  let closing: Promise<void> | null = null;
  const closeOnce = () => {
    closing ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), closeTimeoutMs);
        timer.unref();
      });
      try {
        const outcome = await Promise.race([options.close().then(() => "closed" as const), timeout]);
        log(outcome === "closed" ? "conexões do PostgreSQL encerradas" : "tempo esgotado ao encerrar as conexões");
      } catch (error) {
        const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
        log(`falha ao encerrar as conexões (${typeof code === "string" ? code : "erro"})`);
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (isShuttingDown()) return; // sinal duplicado
    holder[SHUTTING_DOWN_KEY] = true;
    log(`${signal} recebido: aguardando as requisições em andamento`);

    // Fim do drain do Next = sua chamada a process.exit(): fecha os pools antes.
    let exiting = false;
    target.exit = ((code?: number) => {
      if (!exiting) {
        exiting = true;
        void closeOnce().finally(() => originalExit(code ?? EXIT_CODES[signal] ?? 0));
      }
      return undefined as never;
    }) as typeof target.exit;

    // Drain longo demais: não esperar o SIGKILL do Docker.
    const force = setTimeout(() => {
      log("drain excedeu o limite: encerrando");
      void closeOnce().finally(() => originalExit(EXIT_CODES[signal] ?? 1));
    }, forceAfterMs);
    force.unref();
  };

  target.once("SIGTERM", onSignal);
  target.once("SIGINT", onSignal);
}
