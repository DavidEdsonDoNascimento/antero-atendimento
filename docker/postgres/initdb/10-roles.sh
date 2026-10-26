#!/bin/bash
# Executado pelo entrypoint do PostgreSQL SOMENTE na primeira inicialização do
# diretório de dados (volume novo / tmpfs vazio), como o superusuário de
# bootstrap (POSTGRES_USER). Cria os papéis do Antero Atendimentos.
#
# Papéis (nenhum é superusuário, exceto o de bootstrap):
#   antero_owner     NOLOGIN  dono do banco, do schema public e de todos os
#                             objetos criados pelas migrations. Ninguém loga
#                             com ele; a aplicação nunca o assume.
#   antero_migrator  LOGIN    executa as migrations (dbmate). Ao conectar,
#                             assume antero_owner (role = antero_owner), então
#                             os objetos nascem com o dono correto.
#   antero_app       LOGIN    papel da aplicação. Sem superusuário, sem
#                             BYPASSRLS, sem CREATE, sem propriedade de
#                             objetos. Só recebe os privilégios que as
#                             migrations concederem explicitamente.
#
# Variáveis (definidas no compose): POSTGRES_DB, ANTERO_MIGRATOR_PASSWORD,
# ANTERO_APP_PASSWORD, ANTERO_ENABLE_PGTAP ("true" apenas no banco de testes).
set -euo pipefail

: "${POSTGRES_DB:?POSTGRES_DB ausente}"
: "${ANTERO_MIGRATOR_PASSWORD:?ANTERO_MIGRATOR_PASSWORD ausente}"
: "${ANTERO_APP_PASSWORD:?ANTERO_APP_PASSWORD ausente}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v dbname="$POSTGRES_DB" \
  -v migrator_password="$ANTERO_MIGRATOR_PASSWORD" \
  -v app_password="$ANTERO_APP_PASSWORD" <<'SQL'
-- Papéis são objetos do cluster; criados uma única vez por cluster.
CREATE ROLE antero_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE antero_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'migrator_password';
GRANT antero_owner TO antero_migrator;

CREATE ROLE antero_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'app_password';

-- O banco e o schema public pertencem a antero_owner (não ao superusuário).
ALTER DATABASE :"dbname" OWNER TO antero_owner;
ALTER SCHEMA public OWNER TO antero_owner;

-- Ninguém herda acesso por PUBLIC: conexão e uso do schema são concedidos
-- explicitamente.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO antero_migrator, antero_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO antero_app;

-- O migrator assume antero_owner automaticamente ao conectar neste banco.
ALTER ROLE antero_migrator IN DATABASE :"dbname" SET role = 'antero_owner';

-- Funções criadas por antero_owner NÃO ficam executáveis por PUBLIC por
-- padrão (o PostgreSQL concede EXECUTE a PUBLIC em funções novas). Cada função
-- precisa de GRANT EXECUTE explícito à aplicação na migration que a cria.
ALTER DEFAULT PRIVILEGES FOR ROLE antero_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL

if [ "${ANTERO_ENABLE_PGTAP:-false}" = "true" ]; then
  # pgTAP não é extensão "trusted": precisa do superusuário de bootstrap.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c 'CREATE EXTENSION IF NOT EXISTS pgtap'
fi
