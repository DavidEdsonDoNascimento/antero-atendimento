import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Extensões padrão do Next.js. No servidor de desenvolvimento (`next dev`,
// inclusive o dos testes E2E) somam-se `.dev.tsx`/`.dev.ts`: páginas só de
// desenvolvimento, como o simulador de mensagens (`/simulador`). Decidido pela
// FASE, não por NODE_ENV: `next build` nunca compila essas rotas, então elas não
// existem na imagem de produção.
const DEFAULT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];
const DEV_ONLY_PAGE_EXTENSIONS = ["dev.tsx", "dev.ts"];

export default function nextConfig(phase: string): NextConfig {
  return {
    reactCompiler: true,
    pageExtensions:
      phase === PHASE_DEVELOPMENT_SERVER
        ? [...DEV_ONLY_PAGE_EXTENSIONS, ...DEFAULT_PAGE_EXTENSIONS]
        : DEFAULT_PAGE_EXTENSIONS,
    // Imagem Docker de produção (Dockerfile): `.next/standalone` leva só os
    // arquivos rastreados (server.js + node_modules mínimos). Nada de ambiente
    // entra no build — as variáveis são lidas em runtime.
    output: "standalone",
    // Não anuncia o framework em cada resposta.
    poweredByHeader: false,
  };
}
