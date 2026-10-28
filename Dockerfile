# syntax=docker/dockerfile:1.7
#
# Antero Atendimentos — imagem de PRODUÇÃO (Next.js 16 standalone + pnpm 11).
#
#   docker build -t antero-atendimentos/app .                   # aplicação
#   docker build --target migrate -t antero-atendimentos/migrate .   # migrations
#
# Nenhum segredo entra na imagem: o build não lê variáveis de ambiente (provado
# por `pnpm app:build`, sem rede e sem .env) e tudo é configurado em RUNTIME.
# Ver docs/DEPLOY.md.

# Node 24 LTS (Debian bookworm), fixado por digest. Para atualizar:
#   docker pull node:24-bookworm-slim && docker image inspect node:24-bookworm-slim --format '{{index .RepoDigests 0}}'
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:8cabefbd444809cf0e319b5831c65da1ea202200ca552a5e75fd7938a6f86658

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
# Mesma versão de `packageManager` no package.json.
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

# ---------------------------------------------------------------- deps
# Só os manifestos: a camada de dependências só é refeita quando o lockfile muda.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts tsconfig.json postcss.config.mjs ./
COPY src ./src
ENV NODE_ENV=production
RUN pnpm exec next build

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="antero-atendimentos" \
      org.opencontainers.image.description="Antero Atendimentos (Next.js standalone)"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Código somente leitura para o usuário da aplicação (dono: root).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY docker/app/healthcheck.mjs ./healthcheck.mjs
# Único diretório gravável: cache do Next.js.
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
# Prontidão (não só "o processo vive"): o Coolify/Traefik só roteia para
# contêiner saudável e a troca de versão espera este check. Ver docs/DEPLOY.md.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "healthcheck.mjs"]
# Forma exec: o Node é o PID 1 e recebe SIGTERM/SIGINT diretamente.
CMD ["node", "server.js"]

# ---------------------------------------------------------------- migrate
# Executor de migrations (dbmate) com as migrations DESTE commit. Não é a
# aplicação: roda sob demanda, como antero_migrator, ANTES de ativar a nova
# versão (`up` é idempotente e só aplica o que falta). Credencial só em
# runtime (DATABASE_URL). Nunca executa no start da aplicação.
FROM amacneil/dbmate:2.36.0 AS migrate
ENV DBMATE_MIGRATIONS_DIR=/db/migrations \
    DBMATE_NO_DUMP_SCHEMA=true \
    DBMATE_WAIT=true \
    DBMATE_WAIT_TIMEOUT=60s
COPY db/migrations /db/migrations
ENTRYPOINT ["dbmate"]
CMD ["up"]
