/**
 * Liveness: "o processo Node responde". Sem banco, sem login e sem detalhes —
 * só indica que o servidor HTTP está de pé. Uma falha aqui significa processo
 * travado (reiniciar o contêiner). A prontidão (banco, configuração) é
 * `/api/health/ready`. Ver docs/DEPLOY.md.
 */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
