# Deploy — imagem Docker de produção e preparação para o Coolify

> **Estado (Entrega 7A):** a imagem de produção, o procedimento de migrations,
> os health checks, o encerramento controlado e a homologação local estão
> prontos e testados **localmente**. **Nada foi publicado**: nenhum acesso à
> VPS, à Hostinger ou ao Coolify, e nenhum recurso remoto foi criado. A
> publicação é a Entrega 7B (plano no fim deste documento).
>
> Isto **não** prova a segurança do proxy em produção: o Traefik real do
> Coolify ainda não foi testado (ver "Proxy e X-Forwarded-For").

## Visão geral

| Peça | Como será em produção |
| --- | --- |
| Aplicação | recurso Dockerfile do Coolify (alvo `runtime`), uma instância |
| PostgreSQL 17 | recurso **independente e persistente** do Coolify |
| Migrations | alvo `migrate` do mesmo Dockerfile, executado **antes** de ativar a versão |
| Proxy / HTTPS | Traefik do Coolify (Let's Encrypt) |
| E-mail | SMTP de produção (STARTTLS obrigatório) |
| Segredos | variáveis de runtime do Coolify (nunca no Git nem na imagem) |

## A imagem (`Dockerfile`)

Três estágios + um alvo à parte:

| Estágio | Conteúdo |
| --- | --- |
| `base` | Node 24 LTS (bookworm-slim, **fixado por digest**) + pnpm **11.18.0** (`corepack prepare`, igual a `packageManager`) |
| `deps` | só os manifestos → `pnpm install --frozen-lockfile` (camada refeita só quando o lockfile muda) |
| `build` | `next build` com `output: "standalone"`, **sem nenhuma variável de ambiente** |
| `runtime` | `.next/standalone` + `.next/static` + `healthcheck.mjs`; usuário `node` (uid 1000); `NODE_ENV=production`, `PORT=3000`, `HOSTNAME=0.0.0.0`; `CMD ["node","server.js"]` |
| `migrate` | `amacneil/dbmate:2.36.0` + `db/migrations` do mesmo commit; `CMD ["up"]` |

```bash
docker build -t antero-atendimentos/app .                         # o último estágio (runtime) é o padrão
docker build --target migrate -t antero-atendimentos/migrate .
```

- **Tamanho:** ~395 MB em disco (`docker images`), ~95 MB de conteúdo
  comprimido. A base `node:24-bookworm-slim` responde por ~333 MB do tamanho
  em disco; `/app` tem ~49 MB. Uma base Alpine reduziria o tamanho, mas não foi
  avaliada: glibc é o mesmo ambiente do build e dos testes.
- **Sem pnpm nem devDependencies no runtime** (typescript, eslint, tailwind...
  ausentes). O standalone traz só `next`, `pg`, `react`, `react-dom` e o
  que o rastreamento incluiu; Better Auth, Kysely e Nodemailer já vêm no bundle.
- **Código somente leitura** para o processo (`/app` é de root); o único
  diretório gravável é `/app/.next/cache`.
- **Nenhum segredo no build ou na imagem.** O build não lê variáveis
  (provado: o `docker build` roda sem nenhuma e `pnpm app:build` roda com
  `--network none` e sem `.env*`). `pnpm homolog:image-check` verifica
  usuário, ambiente, histórico, arquivos proibidos e busca no sistema de
  arquivos da imagem **cada valor** de `.env.local`/`.env.infra`.
- **`.dockerignore` por lista de permissão:** só `package.json`, lockfile,
  configs, `src/` (sem `*.test.ts`), `docker/app` e `db/migrations` entram no
  contexto; `.env*`, chaves, dumps, `.git`, `node_modules`, `.next` ficam de
  fora mesmo dentro de diretórios liberados.
- **Atualizar a base:** `docker pull node:24-bookworm-slim`, copiar o digest
  (`docker image inspect … --format '{{index .RepoDigests 0}}'`) para o `ARG
  NODE_IMAGE` e rodar `pnpm homolog:build && pnpm homolog:prod`.

## Configuração em runtime

Todas as variáveis são **só de servidor** e entram no contêiner pelo Coolify.
Nomes, formatos e regras: `.env.example`, `docs/AUTH.md`, `docs/INFRA-LOCAL.md`.

| Variável | Produção |
| --- | --- |
| `APP_DATABASE_URL` | `postgres://antero_app:…@<host-do-postgres>:5432/<banco>` — **host do recurso PostgreSQL na rede do Coolify**, nunca `localhost` (dentro do contêiner `localhost` é o próprio contêiner) |
| `AUTH_DATABASE_URL` | idem, papel `antero_auth` |
| `BETTER_AUTH_URL` | `https://<domínio>` exato (só a origem; qualquer outra origem → 403 no login) |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`; trocar invalida todas as sessões |
| `AUTH_TRUSTED_PROXIES` | **obrigatória** (sem ela a configuração é recusada e a prontidão fica 503): CIDR da rede Docker do Traefik no Coolify (ver abaixo) |
| `SMTP_HOST/PORT/USER/PASSWORD`, `MAIL_FROM` | SMTP real; em produção, sem `SMTP_SECURE=true`, exige STARTTLS |
| `APP_DATABASE_*`, `AUTH_DATABASE_*` | tamanhos de pool e timeouts (opcionais) |

`PORT`, `HOSTNAME` e `NODE_ENV` já vêm na imagem. **Não definir `NEXT_PUBLIC_*`.**
A aplicação **nunca** recebe `antero_admin`, `antero_owner` nem
`antero_migrator` (testado: `tests/prod/migrations.test.ts`).

Configuração inválida **não derruba o processo**: ele sobe, mas a prontidão
responde 503 (e o motivo vai para o log), então a nova versão não recebe
tráfego.

## PostgreSQL e migrations

### Papéis (primeiro deploy do banco)

O recurso PostgreSQL do Coolify é uma imagem padrão: o `initdb` da imagem
local (`docker/postgres/initdb/10-roles.sh`) **não roda sozinho**. Execute-o
uma vez, por TCP, com um contêiner descartável na rede do banco (o script é
**idempotente** e também ressincroniza senhas; nunca toca em dados):

```bash
docker run --rm --network <rede-do-postgres> \
  -e PGHOST=<host-do-postgres> -e PGPASSWORD=<senha-do-superusuário-do-recurso> \
  -e POSTGRES_USER=<superusuário-do-recurso> -e POSTGRES_DB=<banco> \
  -e ANTERO_MIGRATOR_PASSWORD=… -e ANTERO_APP_PASSWORD=… -e ANTERO_AUTH_PASSWORD=… \
  -v "$PWD/docker/postgres/initdb:/initdb:ro" postgres:17-bookworm bash /initdb/10-roles.sh
```

(Validado na Entrega 7A contra o PostgreSQL de homologação, inclusive a
reexecução.) As senhas dos três papéis são geradas por quem opera o deploy e
guardadas no Coolify/gerenciador de segredos; `ANTERO_ENABLE_PGTAP` fica
ausente (pgTAP só existe no banco de testes).

### Migrations (nunca no start da aplicação)

A aplicação **não migra**. O alvo `migrate` roda sob demanda, **antes** de
ativar a nova versão, como `antero_migrator`:

```bash
docker build --target migrate -t antero-atendimentos/migrate:<tag> .
docker run --rm --network <rede-do-postgres> \
  -e DATABASE_URL='postgres://antero_migrator:…@<host>:5432/<banco>?sslmode=disable' \
  antero-atendimentos/migrate:<tag> up        # ou: status
```

- **Primeiro deploy e demais:** é o mesmo comando — `up` aplica só o que
  falta. Não dependemos de hooks de pré-deploy do Coolify; ele pode ser
  executado à mão, por CI ou como "pre-deployment command" — o resultado é o
  mesmo, pois a **prontidão da aplicação só passa com o schema aplicado**
  (`/api/health/ready` confere o schema), então uma versão sem migrations
  nunca assume o tráfego.
- **Idempotente e explícito:** reexecutar não reaplica nada (exit 0); migration
  com erro → **exit ≠ 0**, transação desfeita, nada aplicado (testado). O
  `DBMATE_WAIT` (padrão da imagem, 60 s) aguarda o banco aceitar conexões no
  primeiro deploy.
- **Sem reset, DROP ou TRUNCATE.** Os `migrate:down` recusam apagar dados. O
  rollback de uma versão da aplicação **não** desfaz migrations (ver
  "Rollback"); migrations devem ser compatíveis com a versão anterior
  (expandir → migrar → contrair).
- **Transporte TLS:** dentro da rede privada do Coolify use `sslmode=disable`
  como hoje; se o banco for acessado por rede pública, exija TLS (a
  configuração aceita `?sslmode=`).
- Papel `antero_migrator` assume `antero_owner` ao conectar: os objetos nascem
  com o dono certo e a aplicação (`antero_app`/`antero_auth`) continua sujeita
  à RLS.

## Health checks

| Endpoint | Pergunta | Corpo | Verifica |
| --- | --- | --- | --- |
| `GET /api/health` | o processo responde? (liveness) | `{"status":"ok"}` | nada além do servidor HTTP |
| `GET /api/health/ready` | pode receber tráfego? (readiness) | `{"status":"ok"}` 200 ou `{"status":"unavailable"}` **503** | configuração válida; `antero_app` e `antero_auth` conectam (papel verificado) e enxergam o schema (migrations aplicadas); não está encerrando |

Públicos, sem login, sem cache, **sem versão, host, papel, mensagem de erro ou
dado de cliente**. A prontidão usa `has_table_privilege` e `select … limit 0`
(não lê linhas, não passa pela RLS, não a contorna), tem tempo limite de 2 s
por verificação e **guarda o resultado por 2 s** (pedidos simultâneos dividem
uma consulta: não vira amplificador de carga). O motivo da falha vai para o
log (`[health] não pronto (ECONNREFUSED)`), só com o código do erro, e só nas
mudanças de estado.

O `HEALTHCHECK` da imagem consulta a **prontidão** (`node healthcheck.mjs`,
sem curl/wget; 15 s / 5 s / 3 tentativas / 30 s de início).

**Quando uma falha deve impedir o recebimento de tráfego**

- *Deploy de nova versão:* sempre. Configuração inválida, banco inalcançável,
  credencial errada ou migrations pendentes deixam o contêiner `unhealthy` e
  o Coolify mantém a versão antiga (rolling update espera `healthy`).
- *Em execução, falha sustentada do banco:* o Docker marca `unhealthy` e o
  Traefik tira o contêiner do roteamento (o usuário vê 404/"no available
  server" do proxy em vez da página de erro do app). Com **uma** instância isso
  não protege ninguém — é um *trade-off* aceito: mantém o sinal honesto para
  monitoramento. Uma queda curta (< 45 s: 3 falhas × 15 s) não retira o
  contêiner. Se o produto preferir a página de erro do app durante quedas,
  trocar o `HEALTHCHECK` por `/api/health` (liveness) — as migrations deixam de
  ser conferidas no deploy; decidir na 7B.
- *Liveness falhando* (`/api/health` ≠ 200): processo travado → reiniciar.
- O Coolify respeita o `HEALTHCHECK` do Dockerfile e **não injeta o dele**
  (que exigiria curl/wget na imagem). Não configurar outro health check na
  interface do Coolify.

## Encerramento e reinício

O processo é o PID 1 (`CMD` em forma exec) e recebe SIGTERM/SIGINT direto.

1. O Next.js para de aceitar conexões e espera as requisições em andamento.
2. `src/lib/shutdown.ts` (ligado por `src/instrumentation.ts`, só em produção)
   marca "encerrando" (a prontidão passa a 503) e, quando o Next chama
   `process.exit` ao fim do drain, **fecha antes** os pools (`closeAppPool` e
   `closeIdentity`, com limite de 5 s) e sai com o mesmo código (143/130).
3. Se o drain passar de 20 s, fecha os pools e sai por conta própria.
4. Sinais duplicados são ignorados; `process.exit` fica intacto até o primeiro
   sinal.

Configurar o `stop_grace_period`/tempo de parada do Coolify **≥ 30 s**.
Testado (`tests/prod/lifecycle.test.ts`): SIGTERM → exit 143 e SIGINT → 130 em
~6 s; requisição em andamento termina **antes** da saída; 0 conexões restantes
no PostgreSQL; reinício volta `healthy`; queda e volta do PostgreSQL sem
reiniciar a aplicação, sem perda de dados e sem conexões acumuladas.

## Proxy e X-Forwarded-For

O limite de tentativas do Better Auth é **por IP**, e o IP vem do
`X-Forwarded-For`. O Next.js só preenche esse cabeçalho quando ele **não vem na
requisição**; com a aplicação exposta, o cliente escolhe o IP que quiser.
Medido na 7A (`tests/prod/proxy.test.ts`):

| Caminho | 9 tentativas, cada uma com um XFF diferente | Resultado |
| --- | --- | --- |
| Pelo Traefik (entrypoint sem `trustedIPs`) | `401×5`, depois `429` | o Traefik **sobrescreve** o cabeçalho; o app vê um IP só |
| Direto na aplicação (porta publicada) | `401` sempre (12 de 12) | limite **contornado** |

**Condições obrigatórias em produção** (todas precisam valer):

1. A aplicação **não pode ter porta publicada** no host (nem `ports:` no
   compose, nem "Ports Mappings" no Coolify). Atenção: o Docker publica
   *por fora do UFW*; firewall de host não protege uma porta publicada.
2. O tráfego externo passa **só** pelo Traefik.
3. O Traefik deve **sobrescrever** `X-Forwarded-For`: não configurar
   `forwardedHeaders.trustedIPs`/`insecure` nos entrypoints públicos. Se algum
   dia houver CDN/Cloudflare na frente, o `trustedIPs` do Traefik precisa
   listar **apenas** os IPs dela e `AUTH_TRUSTED_PROXIES` os saltos
   intermediários — rever este documento antes.
4. `AUTH_TRUSTED_PROXIES` = **somente** a faixa da rede Docker em que o
   Traefik alcança a aplicação (`docker network inspect coolify` na VPS; é um
   CIDR privado). Não usar `0.0.0.0/0`, nem faixas amplas além da rede do
   proxy. Sem ela a aplicação recusa a configuração (produção).
5. **Não confiar em cabeçalhos do navegador:** o Better Auth lê o `X-Forwarded-For`
   da direita para a esquerda, descartando saltos confiáveis; um valor ilegível
   ou com todos os saltos confiáveis cai num balde único (`no-trusted-ip`) —
   falha *fechada* (compartilha o limite), não um bypass.
6. HTTPS e cookies `Secure`: `BETTER_AUTH_URL=https://…` liga o prefixo
   `__Secure-` e o atributo `Secure` (testado atrás do Traefik com TLS:
   `__Secure-antero.session_token; Secure; HttpOnly; SameSite=Lax; Path=/`, sem
   `Domain`). A origem do navegador precisa ser exatamente `BETTER_AUTH_URL`.
7. Cadastro público permanece **desligado** (404 em `/api/auth/sign-up/email`,
   testado também pelo contêiner de produção).

**Defesas adicionais independentes da topologia (análise)**

| Alternativa | Cobre | Custo | Situação |
| --- | --- | --- | --- |
| Segredo compartilhado Traefik → app (header `X-Antero-Proxy-Token` injetado por middleware do Traefik; o app responde 403 sem ele) | porta publicada por engano; outro contêiner da mesma rede falsificando o XFF | pequeno, mas é **código novo** (proxy.ts + variável) | recomendada como camada extra; não implementada (fora do escopo da 7A) |
| Limite **por conta** (e-mail), atraso/bloqueio progressivo | força bruta distribuída e IP forjado: o atacante precisa derrubar *a conta*, não o IP | médio: gancho `before` do Better Auth + tabela/migration | **recomendada antes de abrir a usuários reais** (ver "Rate limiting") |
| `rate-limit` do Traefik por IP de origem (middleware) | inundação por IP antes de chegar ao app; independente do XFF do app | rótulo no Coolify | recomendada (barata, defesa em profundidade) |
| Cloudflare/WAF na frente | ataques distribuídos | exige reconfigurar `trustedIPs` | opcional |
| `fail2ban` nos logs de acesso do Traefik | persistência de ataques | operação no host | opcional |

Cobertura local: o ambiente de homologação usa o **Traefik 3.6 real** (mesma
família do Coolify) com TLS autoassinado. **O Traefik e a rede reais do
Coolify continuam por testar** — item obrigatório da 7B.

## Rate limiting

Estado: Better Auth 1.7.12, **memória do processo**, por `IP|rota`
(5 logins/60 s, 3 pedidos de redefinição/300 s, 5 trocas de senha/300 s, 100
req/60 s demais). IPv6 é agrupado por /64; o mapa é limitado a 100 000 entradas.

Riscos registrados para a **primeira implantação (1 instância)**:

1. **Reinício/deploy zera os contadores.** Aceitável: o atacante não controla
   reinícios.
2. **Por IP, não por conta.** Um atacante com muitos IPs (botnet) tenta senhas
   de uma mesma conta sem ser limitado; um atacante que forje o IP (só se as
   condições acima falharem) idem. As senhas usam `scrypt`, mínimo 8
   caracteres, e a resposta de erro é igual para conta existente e inexistente.
3. **Balde compartilhado:** se o IP real não puder ser determinado, todas as
   tentativas dividem 5/min por rota (negação de serviço do login, não bypass).
4. **Várias instâncias** dividiriam o contador (cada uma permitiria o limite):
   precisa de armazenamento compartilhado antes de escalar (o Better Auth
   suporta `storage: "database"`, que exige migration; Redis não é necessário).

**Bloqueio?** Para publicar **a homologação 7B** (dados fictícios): não. Para
**abrir a usuários reais**, é *obrigatório decidir* entre (a) implementar o
limite/atraso por conta + `rate-limit` do Traefik, ou (b) aceitar formalmente
o risco da força bruta distribuída contra contas conhecidas. **Recomendação:**
(a), em uma entrega própria (código + migration + testes), sem Redis. Nenhum
serviço novo foi criado.

## Homologação local (`pnpm homolog:*`)

Stack descartável e isolada (`compose.homolog.yaml`, projeto
`antero-atendimentos-homolog`): PostgreSQL (volume próprio), Mailpit com
STARTTLS, Traefik com TLS, a imagem de produção e o executor de migrations.
Segredos e certificado são **gerados na hora** em
`~/.cache/antero-atendimentos/homolog/` (permissão 600, fora do Git); nada vem
de `.env.local`/`.env.infra`. Portas só em `127.0.0.1`: HTTPS **8443**, banco
**55436**, Mailpit **55437**, E2E direto **3471** (nenhuma em uso por outros
projetos). A aplicação não publica porta e só vive em redes `internal`.

```bash
pnpm homolog:build         # imagens runtime e migrate
pnpm homolog:up            # db+mailpit → migrations (passo separado) → app+Traefik
                           # https://localhost:8443 (certificado autoassinado)
pnpm homolog:image-check   # conteúdo da imagem e ausência de segredos
pnpm homolog:e2e           # suíte E2E existente (9) contra a imagem de produção
pnpm homolog:prod          # proxy+TLS+XFF, migrations e ciclo de vida (~3 min)
pnpm homolog:prod proxy    # (ou: lifecycle | migrations)
pnpm homolog:status | homolog:logs [app|db|mailpit|traefik|app-e2e]
pnpm homolog:down          # remove contêineres e redes (mantém o volume)
pnpm homolog:reset         # também remove o volume e os segredos da homologação
```

Para abrir no navegador, aceite o certificado autoassinado; os e-mails ficam
no Mailpit (http://127.0.0.1:55437). Crie usuários fictícios com os fixtures
dos testes ou pelo SQL do `docs/SETUP.md` (apontando para a porta 55436).
`app-e2e` (perfil `e2e`) é a **mesma imagem** publicada em `127.0.0.1:3471`
só para os testes (precisam controlar o XFF) — nunca é o desenho de produção.
Nada disso toca no `compose.yaml` de desenvolvimento, no banco persistente
de desenvolvimento ou em outros projetos Docker.

## Estratégia no Coolify (para a 7B)

1. **Recursos separados:** (a) PostgreSQL 17 (persistente, volume nomeado,
   sem porta pública); (b) aplicação Dockerfile (alvo `runtime`, porta
   interna 3000, **sem** Ports Mappings); (c) job de migrations (alvo
   `migrate`) executado sob demanda.
2. **Rede:** aplicação e banco na mesma rede Docker; `APP_DATABASE_URL` e
   `AUTH_DATABASE_URL` com o hostname interno do recurso PostgreSQL.
3. **Segredos:** três senhas de papéis, `BETTER_AUTH_SECRET`, SMTP — só no
   Coolify (variáveis de runtime; nada em "Build Variables").
4. **Domínio e HTTPS:** domínio no recurso, Let's Encrypt do Traefik;
   `BETTER_AUTH_URL` idêntico ao domínio. Recomendado: redirecionamento
   HTTP→HTTPS e cabeçalhos de segurança (HSTS etc.) no Traefik — não
   configurados hoje.
5. **Proxy:** não ligar `trustedIPs`; descobrir o CIDR da rede (item 4 acima)
   e preencher `AUTH_TRUSTED_PROXIES`; testar o XFF forjado no domínio real.
6. **Migrations controladas:** roles (uma vez) → `migrate … up` → deploy da
   aplicação; nunca no start.
7. **Backups externos e restauração:** `pg_dump` agendado (papel
   `antero_migrator` ou superusuário do recurso) para fora da VPS, com
   **teste de restauração** em banco descartável antes do go-live. Não coberto
   na 7A.
8. **Logs:** stdout/stderr do contêiner (Coolify/`docker logs`). A aplicação não
   registra senhas, tokens, e-mails nem URLs de banco; o Better Auth e o
   shutdown/health usam mensagens curtas. Rotação: configurar `max-size`/
   `max-file` no driver `json-file`.
9. **Health checks:** os da imagem (prontidão); monitor externo em
   `/api/health` (liveness) e `/api/health/ready`.
10. **Rollback:** reimplantar a tag/commit anterior no Coolify (a versão antiga
    só assume com `healthy`). Como as migrations só avançam, mantê-las
    retrocompatíveis; se uma migration for incompatível com a versão
    anterior, o rollback exige restaurar o backup — registrar antes de
    migrar. Guardar a imagem anterior (tag por commit).
11. **Primeiro acesso:** criar organização e administrador por SQL controlado
    (como `docs/SETUP.md`, com o papel dono) — não há cadastro público.

### Checklist da 7B

- [ ] VPS/Coolify: criar PostgreSQL, rodar o bootstrap de papéis e `migrate up`.
- [ ] Criar a aplicação (sem portas publicadas) e as variáveis de runtime.
- [ ] Obter o CIDR da rede do Traefik e preencher `AUTH_TRUSTED_PROXIES`.
- [ ] Confirmar no domínio real: `X-Forwarded-For` forjado **não** burla o
      limite (repetir `tests/prod/proxy.test.ts` adaptado por `curl`);
      `ss -ltn` no host sem a porta 3000; HTTPS válido; cookie `__Secure-`.
- [ ] SMTP real: e-mail de redefinição ponta a ponta.
- [ ] Backup externo + restauração testada.
- [ ] Decidir limite por conta / `rate-limit` do Traefik antes de usuários reais.
- [ ] Cabeçalhos de segurança/HSTS no Traefik.
- [ ] Validar rollback para a versão anterior.
