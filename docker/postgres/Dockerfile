# PostgreSQL 17 do Antero Atendimentos, com pgTAP e pg_prove.
# Usada pelo banco de desenvolvimento e pelo banco de testes (paridade de
# versão e de extensões). A extensão pgtap só é criada no banco de testes.
FROM postgres:17-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-17-pgtap \
      libtap-parser-sourcehandler-pgtap-perl \
 && rm -rf /var/lib/apt/lists/*
