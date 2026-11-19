# WhatsApp Cloud API (E2B-1: webhook e eventos brutos)

Estado: a aplicação **recebe, autentica e guarda** as notificações da Meta. Ainda
**não** transforma essas notificações em conversas nem responde; isso fica para a
E2B-2 (processamento) e a E2C (envio). Nada daqui usa token de envio.

## Peças

| Peça | Onde |
| --- | --- |
| Rota pública | `src/app/api/webhooks/whatsapp/route.ts` (GET verificação, POST notificação) |
| Regras do pedido | `src/modules/whatsapp/webhook-handler.ts` (puro, testável) |
| Assinatura | `src/modules/whatsapp/webhook-signature.ts` (HMAC-SHA256, tempo constante) |
| Configuração | `src/modules/whatsapp/webhook-config.ts` (`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`) |
| Log técnico | `src/modules/whatsapp/webhook-log.ts` (JSON, só códigos e contagens) |
| Gravação | `src/modules/whatsapp/sql-commands.ts` → `webhook_record_delivery` |
| Pool do sistema | `src/lib/db/worker-pool.ts` (`antero_worker`, `WORKER_DATABASE_*`) |
| Banco | `db/migrations/0014_whatsapp_webhook_events.sql` |
| Cadastro de canal | `scripts/whatsapp-channel.mjs` (`pnpm whatsapp:channel`) |

## O pedido da Meta

**GET** `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`:

- token igual a `WHATSAPP_VERIFY_TOKEN` (comparação em tempo constante) → **200**,
  com o `hub.challenge` em texto puro;
- qualquer outro caso → **403**, sem ecoar nada; sem configuração → **503**.

**POST** `/api/webhooks/whatsapp`, nesta ordem:

| Etapa | Falha | Resposta | Grava? |
| --- | --- | --- | --- |
| configuração do webhook | `WHATSAPP_*` ausente/inválida | 503 | não |
| tamanho (Content-Length e leitura em stream) | > 3 MB | 413 | não |
| `X-Hub-Signature-256` sobre o **corpo bruto** | ausente, malformada, diferente, corpo alterado | **401** | **não** |
| JSON (UTF-8) | não é JSON | 400 | não |
| `webhook_record_delivery` (antero_worker) | banco fora, pool sem configuração, tempo esgotado | **503** (a Meta reentrega) | não |
| — | — | **200** (só depois do COMMIT) | sim |

Estrutura inesperada, mas JSON assinado, recebe 200 e vira uma linha `rejected`
(`invalid_payload`), porque reentregar não mudaria nada. Respostas sem
nenhum detalhe interno (`ok`, `unauthorized`, `unavailable`…).

A rota é pública só nesse caminho (`PUBLIC_PREFIXES` em
`src/lib/auth/route-access.ts`); `/api/webhooks` e qualquer outro caminho continuam
exigindo login. Só GET e POST (o resto recebe 405).

## Organização: só pelo canal registrado

O corpo nunca informa a organização. Para cada alteração `entry[].changes[]`:

1. `value.metadata.phone_number_id` → canal `cloud_api` com esse Phone Number ID
   (único entre todas as organizações);
2. a WABA do canal tem de ser `entry[].id`;
3. canal `connected` e organização `active`.

| Situação | Estado | Motivo | Organização gravada |
| --- | --- | --- | --- |
| tudo confere | `received` | — | sim |
| número sem canal | `rejected` | `unknown_channel` | não |
| número de um canal, WABA de outra conta | `rejected` | `waba_mismatch` | **não** (nenhuma das duas) |
| canal desconectado | `rejected` | `channel_disconnected` | sim (é dela) |
| organização suspensa | `rejected` | `organization_inactive` | sim |
| campo que não é `messages` | `rejected` | `unsupported_field` | não |
| sem Phone Number ID | `rejected` | `missing_phone_number_id` | não |
| estrutura inválida / mais de 1000 alterações | `rejected` | `invalid_payload` / `too_many_changes` | não |

Uma notificação com números de duas organizações vira linhas separadas, cada uma
na sua. Nada fora de `webhook_events` é alterado pelo registro.

## Regras do canal cloud_api (0014)

- `external_account_id` = Phone Number ID, `external_business_account_id` = WABA,
  ambos numéricos e obrigatórios em `cloud_api` (canais `development` não têm WABA);
- Phone Number ID **único** entre canais `cloud_api` de qualquer organização;
- uma WABA pertence a **uma** organização (gatilho, com trava por WABA);
- organização, provedor, Phone Number ID e WABA de um canal `cloud_api` **não
  mudam** depois de criado (`WH011`): trocar o número é cadastrar outro canal.
  O status (`connected`/`disconnected`) pode mudar.

## Duplicidade e durabilidade

- Chave: sha256 da alteração em forma canônica (jsonb) com a WABA. Reentrega,
  mesmo com outra formatação, conta como duplicata e não grava de novo; 20
  reentregas simultâneas viram uma linha (testado).
- A idempotência por mensagem (wamid) é a de `messages` (0003), usada na E2B-2.
- O 200 só sai depois do COMMIT. Sem banco, 503: a Meta reentrega com espera
  crescente por até 7 dias. Uma indisponibilidade curta não perde mensagem.
- Nada depende de memória depois da resposta: o evento `received` fica no banco
  até alguém o tratar.

## Fila para a E2B-2 (já no banco, ainda sem uso pela aplicação)

- `webhook_claim_events(limite 1–100, prazo 10–900 s)`: reivindica pendentes com
  `FOR UPDATE SKIP LOCKED`, gera um `claim_token` e conta uma tentativa.
- `webhook_finish_event(id, token, resultado, motivo)`:
  - `processed`, `rejected` ou `failed` (os dois últimos com motivo em código);
  - `retry`: volta à fila com espera de 30 s, 1 min, 2 min… até 1 h;
  - quem perdeu o prazo e foi substituído recebe `WH001`;
  - repetir o encerramento com o mesmo token não muda nada.
- Prazo vencido (processo que caiu) volta à fila; na 10ª tentativa vira `failed`
  (`max_attempts`).

## Segurança

| Papel | `webhook_events` | Funções `webhook_*` |
| --- | --- | --- |
| `antero_worker` | nenhum privilégio (só pelas funções) | executa as 3 |
| `antero_app` | nenhum (nem owner nem admin da plataforma lê) | nenhuma |
| `antero_auth` | nenhum | nenhuma |

- RLS habilitada sem política, como defesa extra. `antero_worker`:
  - não lê nenhuma tabela;
  - não altera vínculos;
  - não executa ingestão, administração nem automações.
- O corpo bruto contém telefones, nomes e mensagens: fica só no banco, nunca no log.
  O log tem tipo, evento, id, instante, motivo, bytes, contagens e SQLSTATE.
- Nenhuma regra da G2A/G2B/G2C muda; `ingest_inbound_message` e `dev_automation_*`
  continuam exigindo usuário humano e canal `development`.

## Configuração

| Variável | Uso |
| --- | --- |
| `WORKER_DATABASE_URL` | `postgres://antero_worker:…@host/banco` (papel conferido em cada conexão) |
| `WORKER_DATABASE_POOL_MAX` etc. | opcionais (padrões: 3 conexões, 3 s para conectar, 10 s por comando) |
| `WHATSAPP_APP_SECRET` | App Secret do aplicativo na Meta |
| `WHATSAPP_VERIFY_TOKEN` | valor aleatório escolhido por você (24+ caracteres `A-Za-z0-9._~-`) |

Sem elas o webhook responde 503 e o resto da aplicação funciona; a prontidão
(`/api/health/ready`) não depende do webhook. `WHATSAPP_ACCESS_TOKEN` e
`WHATSAPP_GRAPH_API_VERSION` são da E2C e ainda não são lidas.

## Provisionamento do papel e da migration

O papel nasce no `10-roles.sh`, que o PostgreSQL só roda num volume **novo**.

- **Banco novo** (volume vazio, banco de testes, homologação): o initdb cria o
  papel; depois `migrate up`.
- **Banco local existente** (volume já inicializado):
  1. `pnpm infra:env` acrescenta `DEV_WORKER_PASSWORD`/`TEST_WORKER_PASSWORD` ao
     `.env.infra` sem trocar nenhuma senha existente;
  2. `pnpm db:roles` (dev) roda o script no contêiner **existente**, com as senhas
     atuais passadas pelo ambiente do `exec`. Não recria nem reinicia o
     contêiner e só cria/sincroniza papéis, sem tocar em dados;
  3. `pnpm db:verify` confere o papel;
  4. `pnpm db:migrate`. Sem o papel, a 0014 recusa com a instrução e não aplica nada.

  O `compose.yaml` passa a declarar `ANTERO_WORKER_PASSWORD`. Por isso o próximo
  `pnpm infra:up` recria o contêiner de desenvolvimento (o volume é preservado),
  como em qualquer mudança no compose. `db:roles`, `db:verify` e `db:migrate`
  não recriam nem reiniciam o banco: usam `exec` ou `run --no-deps`, e o
  executor de migrations exige o banco já no ar.
- **Servidor**: rode o `10-roles.sh` por TCP com `ANTERO_WORKER_PASSWORD` (ver
  `docs/DEPLOY.md`); depois o alvo `migrate`; por fim defina `WORKER_DATABASE_URL`
  na aplicação.

Testado: banco de testes novo; e um PostgreSQL descartável inicializado com o
`10-roles.sh` da `main` (sem o papel), em que a 0014 recusou, o script novo criou o
papel no contêiner existente sem recriá-lo e a 0014 aplicou.

Rollback da 0014: recusado se houver evento ou canal `cloud_api`. A migration
falha sem efeito se já existir canal `cloud_api` sem Phone Number ID/WABA numéricos.

## Cadastro de um canal

Simula por padrão; só grava com `--apply`. Não apaga nada e não troca a
identidade de um canal existente (só o status).

```bash
pnpm whatsapp:channel test -- --organization <uuid> \
  --phone-number-id <Phone Number ID> --waba-id <WABA ID> \
  [--display-phone +55…] [--display-name "Atendimento"] [--status connected] [--apply]
```

Num servidor: `node --env-file=<arquivo com WHATSAPP_CHANNEL_DATABASE_URL> scripts/whatsapp-channel.mjs …`
(papel `antero_migrator`). Recusa organização inexistente ou suspensa, número ou
WABA de outra organização e entrada fora do formato.

## Meta: o que configurar

Teste com número de desenvolvimento:

1. App no Meta for Developers (tipo Business, caso de uso WhatsApp). Anote o **App
   Secret** (Configurações > Básico) e guarde-o só na variável do ambiente.
2. Número de teste: anote **Phone Number ID** e **WABA ID** e cadastre o canal
   com o script.
3. URL HTTPS pública com certificado válido (túnel para uma instância isolada;
   autoassinado não serve).
4. Em WhatsApp > Configuração: Callback URL `https://<host>/api/webhooks/whatsapp`,
   Verify Token = `WHATSAPP_VERIFY_TOKEN`, "Verificar e salvar", assinar o campo
   **`messages`**.
5. Mandar uma mensagem do seu celular para o número de teste: deve aparecer uma
   linha `received` em `webhook_events`.

Produção (cliente real): verificação da empresa, App Review com acesso avançado,
número registrado, nome de exibição e forma de pagamento. Ver o relatório
`claude-reports/2026-11-18-investigacao-mvp-whatsapp-e2b-e2c.md`, seção G.

## Retenção

Eventos finalizados (`processed`, `rejected`, `failed`) ficam **30 dias**
(`finished_at`, índice parcial pronto); pendentes ficam até serem tratados.
**Não há rotina de exclusão nesta entrega.**

## Pendências (E2B-2 em diante)

- Processar `received` usando a fila:
  - ingestão por porta própria, com a organização vinda do canal;
  - wamid como idempotência;
  - horário da Meta;
  - automação pela porta worker.
- Mídias e tipos não suportados **não** podem chegar ao motor como texto comum.
- Contatos identificados só por BSUID (sem telefone): suporte completo antes do piloto.
- Status de entrega (`statuses[]`), varredura em processo e rotina de limpeza dos 30 dias.
