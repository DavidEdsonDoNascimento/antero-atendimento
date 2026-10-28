import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Imagem Docker de produção (Dockerfile): `.next/standalone` leva só os
  // arquivos rastreados (server.js + node_modules mínimos). Nada de ambiente
  // entra no build — as variáveis são lidas em runtime.
  output: "standalone",
  // Não anuncia o framework em cada resposta.
  poweredByHeader: false,
};

export default nextConfig;
