import { pingAppDatabase } from "@/lib/db";
import { createReadinessProbe } from "@/lib/health";
import { pingIdentityDatabase } from "@/lib/identity/lifecycle";
import { isShuttingDown } from "@/lib/shutdown";

/**
 * Readiness: configuração válida + PostgreSQL acessível pelos DOIS papéis
 * (`antero_app` e `antero_auth`) + migrations aplicadas. 200 = pode receber
 * tráfego; 503 = não (inclusive durante o encerramento). Resposta sem
 * detalhes (endpoint público); o motivo vai para o log. Ver docs/DEPLOY.md.
 */
const isReady = createReadinessProbe({
  checks: [pingAppDatabase, pingIdentityDatabase],
  isShuttingDown,
});

export async function GET() {
  const ready = await isReady();
  return Response.json(
    { status: ready ? "ok" : "unavailable" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
