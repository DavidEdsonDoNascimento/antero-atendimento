// HEALTHCHECK do contêiner da aplicação (Dockerfile). Só o Node, sem curl/wget.
// Consulta a PRONTIDÃO (/api/health/ready): configuração válida + PostgreSQL
// acessível + migrations aplicadas. Sai 0 só com HTTP 200; qualquer outra
// coisa (503, erro, tempo esgotado) = não saudável. Nunca imprime a resposta.
const port = process.env.PORT || "3000";

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
    signal: AbortSignal.timeout(3000),
    redirect: "manual",
  });
  process.exit(response.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
