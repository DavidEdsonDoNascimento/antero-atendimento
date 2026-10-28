// Sonda de PRONTIDÃO (`/api/health/ready`) — lógica pura, sem `server-only`,
// testável com `node --test`. As verificações reais (PostgreSQL da aplicação e
// da identidade) são injetadas pela rota.
//
// Endpoint público e sem login: por isso o resultado é só "pronto" ou "não" —
// nunca versão, host, papel, mensagem de erro ou contagem de conexões. O
// motivo da falha vai para o log do servidor (apenas código/nome do erro).
// O resultado é guardado por poucos segundos e pedidos simultâneos dividem a
// mesma verificação: o endpoint não vira amplificador de carga no banco.

export type ReadinessOptions = {
  /** Verificações que precisam passar (rejeitar = não pronto). */
  checks: Array<() => Promise<void>>;
  /** Verdadeiro durante o encerramento: nunca pronto. */
  isShuttingDown?: () => boolean;
  /** Tempo máximo de cada verificação. */
  timeoutMs?: number;
  /** Quanto tempo um resultado é reaproveitado. */
  cacheMs?: number;
  now?: () => number;
  log?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_MS = 2_000;

function describeFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === "string" && code) return code;
    if (typeof name === "string" && name) return name;
  }
  return "erro";
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createReadinessProbe(options: ReadinessOptions): () => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(`[health] ${message}`));

  let cached: { ready: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  let lastLogged: boolean | null = null;

  const run = async (): Promise<boolean> => {
    let ready = true;
    let reason = "";
    try {
      await Promise.all(options.checks.map((check) => withTimeout(check(), timeoutMs)));
    } catch (error) {
      ready = false;
      reason = describeFailure(error);
    }
    // Só registra quando o estado muda (sem inundar o log a cada sondagem).
    if (lastLogged !== ready && !(lastLogged === null && ready)) {
      log(ready ? "prontidão restabelecida" : `não pronto (${reason})`);
    }
    lastLogged = ready;
    cached = { ready, at: now() };
    return ready;
  };

  return async () => {
    if (options.isShuttingDown?.()) return false;
    if (cached && now() - cached.at < cacheMs) return cached.ready;
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
