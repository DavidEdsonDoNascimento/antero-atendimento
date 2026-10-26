#!/bin/bash
# Cria/sincroniza os papéis do Antero Atendimentos.
#
# Executado pelo entrypoint do PostgreSQL na primeira inicialização do
# diretório de dados (volume novo / tmpfs vazio), como o superusuário de
# bootstrap (POSTGRES_USER). É IDEMPOTENTE: `pnpm db:roles <dev|test>` roda o
# mesmo script num banco já inicializado para criar papéis novos (ex.:
# antero_auth, Entrega 2) e ressincronizar senhas com .env.infra — sem tocar
# em dados.
#
# Papéis (nenhum é superusuário, exceto o de bootstrap):
#   antero_owner     NOLOGIN  dono do banco, dos schemas e de todos os
#                             objetos criados pelas migrations. Ninguém loga
#                             com ele; a aplicação nunca o assume.
#   antero_migrator  LOGIN    executa as migrations (dbmate). Ao conectar,
#                             assume antero_owner (role = antero_owner), então
#                             os objetos nascem com o dono correto.
#   antero_app       LOGIN    papel da aplicação. Sem superusuário, sem
#                             BYPASSRLS, sem CREATE, sem propriedade de
#                             objetos. Só recebe os privilégios que as
#                             migrations concederem explicitamente. NÃO
#                             enxerga o schema `auth` (hashes, tokens).
#   antero_auth      LOGIN    papel exclusivo do Better Auth. Mesmas
#                             restrições do antero_app; as migrations lhe
#                             concedem só o schema `auth` (nada em `public`).
#
# Variáveis (definidas no compose): POSTGRES_DB, ANTERO_MIGRATOR_PASSWORD,
# ANTERO_APP_PASSWORD, ANTERO_AUTH_PASSWORD, ANTERO_ENABLE_PGTAP ("true"
# apenas no banco de testes).
set -euo pipefail

: "${POSTGRES_DB:?POSTGRES_DB ausente}"
: "${ANTERO_MIGRATOR_PASSWORD:?ANTERO_MIGRATOR_PASSWORD ausente}"
: "${ANTERO_APP_PASSWORD:?ANTERO_APP_PASSWORD ausente}"
: "${ANTERO_AUTH_PASSWORD:?ANTERO_AUTH_PASSWORD ausente}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v dbname="$POSTGRES_DB" \
  -v migrator_password="$ANTERO_MIGRATOR_PASSWORD" \
  -v app_password="$ANTERO_APP_PASSWORD" \
  -v auth_password="$ANTERO_AUTH_PASSWORD" <<'SQL'
-- Papéis são objetos do cluster. Criados só se ainda não existirem; os
-- atributos e senhas são (re)aplicados sempre, para que uma nova execução
-- corrija qualquer desvio. (\gexec executa o comando gerado apenas quando o
-- SELECT devolve uma linha.)
SELECT 'CREATE ROLE antero_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'antero_owner') \gexec
ALTER ROLE antero_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

SELECT 'CREATE ROLE antero_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'antero_migrator') \gexec
ALTER ROLE antero_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'migrator_password';
GRANT antero_owner TO antero_migrator;

SELECT 'CREATE ROLE antero_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'antero_app') \gexec
ALTER ROLE antero_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'app_password';

SELECT 'CREATE ROLE antero_auth'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'antero_auth') \gexec
ALTER ROLE antero_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'auth_password';

-- O banco e o schema public pertencem a antero_owner (não ao superusuário).
ALTER DATABASE :"dbname" OWNER TO antero_owner;
ALTER SCHEMA public OWNER TO antero_owner;

-- Ninguém herda acesso por PUBLIC: conexão e uso do schema são concedidos
-- explicitamente. antero_auth NÃO recebe USAGE em public: só enxerga o
-- schema `auth` (concedido pela migration 0000).
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO antero_migrator, antero_app, antero_auth;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO antero_app;

-- O migrator assume antero_owner automaticamente ao conectar neste banco.
ALTER ROLE antero_migrator IN DATABASE :"dbname" SET role = 'antero_owner';

-- Funções criadas por antero_owner NÃO ficam executáveis por PUBLIC por
-- padrão (o PostgreSQL concede EXECUTE a PUBLIC em funções novas). Cada função
-- precisa de GRANT EXECUTE explícito na migration que a cria.
ALTER DEFAULT PRIVILEGES FOR ROLE antero_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL

if [ "${ANTERO_ENABLE_PGTAP:-false}" = "true" ]; then
  # pgTAP e dblink não são extensões "trusted": precisam do superusuário de
  # bootstrap. dblink permite testar concorrência real (duas conexões) nos
  # testes pgTAP; fica num schema próprio, sem acesso para os papéis da
  # aplicação. Só no banco de testes.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c 'CREATE EXTENSION IF NOT EXISTS pgtap' \
    -c 'CREATE SCHEMA IF NOT EXISTS test_tools' \
    -c 'REVOKE ALL ON SCHEMA test_tools FROM PUBLIC' \
    -c 'CREATE EXTENSION IF NOT EXISTS dblink SCHEMA test_tools'
fi
