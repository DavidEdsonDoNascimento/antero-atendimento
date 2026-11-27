# WhatsApp Cloud API (E2B-1: webhook e eventos brutos; E2B-2a: ingestão)

Estado:

- a aplicação **recebe, autentica e guarda** as notificações da Meta (E2B-1);
- o banco já tem a **porta segura de ingestão** (E2B-2a, 0015): uma mensagem de
  um evento reivindicado vira contato, conversa e mensagem na organização do
  canal. **Ainda não há consumidor da fila** (E2B-2c/2d), nem automação real
  (E2B-2b) nem envio (E2C). Nada daqui usa token de envio.

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
| Banco | `db/migrations/0014_whatsapp_webhook_events.sql`, `0015_whatsapp_inbound_ingest.sql` |
| Ingestão de uma mensagem | `src/modules/whatsapp/sql-commands.ts` → `ingestWebhookMessage` → `webhook_ingest_message` |
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

## Ingestão de uma mensagem (E2B-2a, 0015)

```sql
webhook_ingest_message(p_event_id bigint, p_claim_token uuid, p_wamid text)
  returns (outcome, reason, organization_id, whatsapp_account_id, contact_id,
           conversation_id, message_id, hold_id, duplicate, reopened,
           provider_time_status, identity_note)
```

Só `antero_worker` executa. O chamador informa **qual** mensagem (wamid) de
**qual** evento reivindicado quer ingerir; organização, canal, telefone, nome,
texto, tipo e horário saem da linha persistida em `webhook_events`, nunca de
parâmetros. Ordem das conferências:

1. evento existe (`P0002`), está `received`, com **este** token e prazo ainda
   válido (`WH001`); campo `messages` (`WH003`); o wamid está em
   `value.messages` do evento (`WH002`); canal `cloud_api` (`WH004`, recusa
   `development`). Parâmetros ausentes ou wamid fora de 1–256 caracteres: `22023`;
2. situação **atual**: mesmos ids do canal no evento, canal `connected`,
   organização `active`, módulo Atendimento **ou** Automações ligado. Senão
   `rejected` (`channel_mismatch`, `channel_disconnected`,
   `organization_inactive`, `modules_disabled`), sem gravar nada;
3. reação e mensagem de sistema: `ignored` (`reaction`, `system`), sem gravar.
   Ficam no evento bruto (30 dias);
4. trava por (canal, wamid): mensagem existente → `duplicate`; retenção
   existente → `held` com `duplicate = true`;
5. identidade e conteúdo (abaixo): o que não for seguro vira retenção (`held`);
6. senão `created` (contato e conversa por `ingest_inbound_internal`, o mesmo
   corpo da porta do simulador; conversa resolvida é reaberta).

| Tipo da Meta | Conteúdo gravado |
| --- | --- |
| `text` | o corpo (1–4096 após trim). Vazio → retida `invalid_content`; acima de 4096 → retida `content_too_long` (inteira, **nunca cortada** em `messages`) |
| `interactive` `list_reply`/`button_reply` | o título; o id escolhido em `interaction_reply_id` |
| `audio`, `image`, `video`, `document`, `sticker`, `location` | `[Áudio recebido — conteúdo indisponível no Antero]` etc.; a legenda de imagem, vídeo ou documento vem depois do marcador, cortada para caber em 4096 |
| qualquer outro (`contacts`, `button` de template, `order`, `unsupported`, outro `interactive`) | `[Mensagem recebida — formato não suportado]` |
| `reaction`, `system` | nada (`ignored`) |

O tipo original fica em `messages.provider_message_type` (o `message_type` da
recebida continua `text`). Na E2B-2b o motor só deve tratar como resposta do
cliente `text` e `interactive` com `interaction_reply_id`; marcador e legenda
nunca são resposta. Nenhuma mídia é baixada.

### Identidade do contato e BSUID

- O telefone (`messages[].from`, o `wa_id`) continua sendo a identidade: contato
  por (organização, `+` + `from`), como antes. O `wa_id` é usado como a Meta
  manda (sem ajustar o 9º dígito), porque é para ele que se responde.
- O nome (`contacts[].profile.name`, até 256) só entra na **criação** do contato.
- BSUID (`messages[].from_user_id` ou `contacts[].user_id`). O que a documentação
  da Meta diz (lida em 2026-11-27): "código do país + ponto + até 128
  alfanuméricos" (variante parent com `ENT.`), **escopo do portfólio
  empresarial**, regenerado quando o usuário troca de número. A organização não
  é o portfólio, e a mesma página fala em "per-phone-number BSUID" no Contact
  Book sem conciliar. Por isso:
  - formato conservador (`[A-Za-z0-9.]`, até 160) e **nenhum índice único**;
  - gravado em `contacts.whatsapp_user_id` só quando o campo está vazio; nunca
    sobrescrito, nunca usado para unir contatos;
  - fora do formato: descartado, a mensagem segue pelo telefone
    (`identity_note = bsuid_invalid`);
  - **política conservadora (MVP): qualquer divergência retém** a mensagem por
    `identity_conflict`, sem tocar no contato nem no histórico:

    | Situação | Resultado | `identity_note` |
    | --- | --- | --- |
    | telefone válido, contato com o **mesmo** BSUID | ingere | — |
    | telefone válido, contato **sem** BSUID | ingere e preenche o BSUID | — |
    | mensagem **sem** BSUID | ingere pelo telefone (como antes) | — |
    | contato do telefone com **outro** BSUID | retida | `bsuid_mismatch` |
    | BSUID já é de **outro** contato da organização | retida | `bsuid_in_use` |
    | a notificação traz dois BSUIDs para a mensagem | retida | `bsuid_contradiction` |
    | sem telefone válido | retida (`missing_phone`/`invalid_phone`) | — |

    O BSUID recebido fica na retenção (`provider_user_id`), nunca descartado.
    `identity_note` volta só no resultado da função: o processador registra o
    código, **nunca** telefone, BSUID ou nome em log.
  - **Limitação aceita no MVP:** o BSUID é gravado sem o escopo (portfólio/WABA).
    Uma pessoa que fala com canais de **portfólios diferentes** da mesma
    organização tem BSUIDs diferentes, e a política acima retém essas mensagens
    legítimas. Reavaliar (identidade por escopo empresarial) **antes de operar
    com mais de um portfólio**. Número reciclado (outra pessoa no mesmo número) é
    o caso que a política protege;
  - `parent_user_id` não é guardado.
- Sem telefone (usuário com nome de usuário, Meta desde 2026) ou telefone fora do
  E.164: retida (`missing_phone` / `invalid_phone`). **Nenhum contato fictício.**

### Horário da Meta e janela de 24 h

- `messages[].timestamp` (segundos Unix em texto) é **válido** se cair entre 30
  dias antes e 5 minutos depois da **chegada do webhook**
  (`webhook_events.received_at`), não do processamento da fila. 30 dias cobrem
  com folga a reentrega da Meta (até 7 dias); 5 minutos cobrem relógio
  adiantado. Fora disso: `out_of_range`; não numérico: `invalid`; ausente:
  `missing`. A mensagem entra mesmo assim, com `provider_sent_at` nulo.
- `messages.provider_sent_at` (só válido) e `messages.webhook_received_at`
  (sempre, nas recebidas pela Cloud API) preservam os dois horários.
- **Janela de 24 h de canal `cloud_api`** (`send_conversation_reply` e o detalhe
  da Inbox, mesma regra): o maior `least(provider_sent_at, webhook_received_at)`
  das recebidas com horário válido. Sem nenhum, **não há janela**. Atrasada não
  prolonga, fora de ordem não encurta, relógio adiantado não passa da chegada.
- Canal `development`: a regra anterior (última recebida por `created_at`).
- A ordem da fila e da Inbox continua a de chegada (`arrival_order`,
  `created_at`, `last_message_at = now()`): uma mensagem atrasada não faz a
  conversa regredir.

### Retenções (`webhook_message_holds`)

| Item | Regra |
| --- | --- |
| Finalidade | guardar mensagem **válida** que não pôde virar conversa com segurança, para recuperação futura (suporte completo a BSUID, correção manual) |
| Motivos | `missing_phone`, `invalid_phone`, `invalid_content`, `content_too_long` (texto acima de 4096), `identity_conflict` |
| Estados | `held` (aguardando); `resolved` (virou mensagem, `resolved_message_id`); `discarded`. Só `held` existe nesta entrega: **não há recuperação automática nem tela** |
| Conteúdo | só o elemento `messages[i]` e o `contacts[j]` correspondente, o wamid, o BSUID válido, os horários e o tipo; não a notificação inteira |
| Limites | `message` até **512 KiB**, `contact` até **16 KiB** (`pg_column_size`, o mesmo que a constraint mede; `webhook_hold_copy` confere antes de gravar). Um texto de 65.536 caracteres (limite usual do aplicativo; a documentação da Meta lida não fixa um máximo para mensagens recebidas) cabe inteiro, mesmo em emoji (~256 KiB). O limite do corpo do webhook (3 MB) não mudou |
| Acima do limite | cópia **limitada**, marcada `message_storage`/`contact_storage = 'size_limited'`: só identificação (`id`, `from`, `from_user_id`, `timestamp`, `type`; contato: `wa_id`, `user_id`, `profile_name_prefix`), cada campo cortado, e os primeiros 4096 caracteres do texto em `text_body_prefix`. Fora do formato da Meta de propósito: `webhook_message_content` a lê como `invalid`, então nunca vira mensagem nem resposta de automação. Nunca erro de constraint, descarte ou retentativa |
| Rastreabilidade | sempre `message_original_bytes` e `message_sha256` (texto canônico `jsonb::text` do elemento **original**) e `contact_original_bytes`. **Limitação:** o original de uma cópia limitada só existe no evento bruto, que some na purga de 30 dias; depois disso, só o hash e o tamanho |
| Evento de origem | `event_id` anulável, `ON DELETE SET NULL`: a retenção **sobrevive** à purga de 30 dias dos eventos (testado) |
| Consistência | FKs compostas: canal e evento da mesma organização; mensagem resolvida do mesmo canal; um wamid por canal (único) |
| Prazo | 90 dias desde `created_at` (índice pronto). A purga é entrega própria |
| Acesso | RLS sem política e nenhum privilégio: nem `antero_app` (owner, admin da plataforma), nem `antero_auth`, nem `antero_worker` leem. Só manutenção (`antero_migrator`) |
| Repetição | uma mensagem retida continua retida mesmo se chegar de novo com telefone (sem recuperação automática) |

### Concorrência

- A trava consultiva por (canal, wamid) é a mesma da ingestão interna: mensagem
  existente, retenção existente e ingestão nova se excluem. Testado com 20
  chamadas simultâneas, 5 eventos com a mesma mensagem e corridas entre o
  caminho com telefone e o sem telefone (nunca mensagem e retenção juntas).
- Quando há BSUID, a decisão de identidade é tomada sob duas travas a mais,
  **sempre nesta ordem**: (canal, wamid) → (organização, telefone) →
  (organização, BSUID) → linhas (contato, conversa). O mesmo telefone com
  BSUIDs diferentes e o mesmo BSUID em telefones diferentes nunca são decididos
  por duas transações ao mesmo tempo; a segunda enxerga o BSUID que a primeira
  gravou e é retida. Ordem fixa e uma trava de cada tipo por chamada: sem ciclo,
  sem deadlock (testado com telefones e BSUIDs cruzados em paralelo).
- Defesa: se o BSUID do contato mudar sob a trava (ninguém mais o grava),
  `WH005 identity_race` desfaz a transação inteira, sem mensagem contraditória.
- **Uma ingestão por transação** (o `workerQuery` usa autocommit). Várias
  ingestões numa só transação acumulariam travas fora da ordem.
- O evento fica `FOR SHARE` durante a ingestão: várias mensagens do mesmo evento
  entram em paralelo, mas uma nova reivindicação ou o encerramento esperam.
- Nenhuma trava global: organizações e canais diferentes não se esperam.

## Segurança

| Papel | `webhook_events` / `webhook_message_holds` | Funções `webhook_*` |
| --- | --- | --- |
| `antero_worker` | nenhum privilégio (só pelas funções) | executa as 4 (`webhook_record_delivery`, `webhook_claim_events`, `webhook_finish_event`, `webhook_ingest_message`) |
| `antero_app` | nenhum (nem owner nem admin da plataforma lê) | nenhuma |
| `antero_auth` | nenhum | nenhuma |

`ingest_inbound_internal` e `webhook_message_content` não são executáveis por
nenhum papel; só as funções `SECURITY DEFINER` as chamam.

- RLS habilitada sem política, como defesa extra. `antero_worker`:
  - não lê nenhuma tabela;
  - não altera vínculos;
  - não executa ingestão, administração nem automações.
- O corpo bruto contém telefones, nomes e mensagens: fica só no banco, nunca no log.
  O log tem tipo, evento, id, instante, motivo, bytes, contagens e SQLSTATE.
- O `hub.verify_token` chega na query string do GET de verificação. A aplicação não
  registra URLs, mas o access log de um proxy registra (o Traefik da homologação
  grava a URL inteira). Em produção: access log do proxy desligado ou sem a query,
  e troque o token se ele tiver ido para um log. Ele só serve para a verificação;
  forjar notificação exige o App Secret.
- Nenhuma regra da G2A/G2B/G2C muda; `ingest_inbound_message` e `dev_automation_*`
  continuam exigindo usuário humano e canal `development` (mesmas checagens, na
  mesma ordem; o corpo da ingestão foi para `ingest_inbound_internal`).

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

0015: exige o papel `antero_worker` (já provisionado com a 0014). Só acrescenta
colunas anuláveis, constraints, uma tabela e funções; linhas existentes ficam com
os campos novos nulos. Rollback recusado se houver retenção, BSUID em contato ou
mensagem com campos da Meta; sem isso, restaura `ingest_inbound_message` (0005) e
`send_conversation_reply` (0008) com o mesmo corpo. Validado sobre uma cópia
restaurada do banco de desenvolvimento (up, down, up e as três recusas).

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

- Eventos finalizados (`processed`, `rejected`, `failed`) ficam **30 dias**
  (`finished_at`, índice parcial pronto); pendentes (`received`, inclusive os
  reivindicados) ficam até serem tratados. Apagar um evento finalizado não afeta
  as retenções (testado). A deduplicação permanente é o wamid em `messages` e em
  `webhook_message_holds`.
- Retenções de mensagens: 90 dias (`created_at`).
- **Não há rotina de exclusão nesta entrega.**

## Pendências (E2B-2b em diante)

- **E2B-2b:** automação pela porta do worker, usando `provider_message_type`
  (marcador e legenda nunca são resposta; mídia vai para a equipe quando houver
  Atendimento), `interaction_reply_id` para a lista e a política de mensagem
  atrasada (N8: mais de 15 min entre o horário da Meta e a chegada → a automação
  não começa nem avança e a conversa vai para a equipe).
- **E2B-2c/2d:** consumidor da fila (claim → ingestão por wamid → finish), gatilho
  `after()` mais varredura periódica, encerramento controlado e purga.
- `statuses[]` (sent/delivered/read/failed): E2C-1. Até lá ficam no evento bruto.
- Mensagens de sistema (`user_changed_number`, `user_changed_user_id`, com
  `previous_user_id`): hoje `ignored`, só no evento bruto (30 dias). São o sinal
  oficial de troca de identidade; tratar junto com a identidade por escopo.
- **Antes do piloto comercial: consulta operacional das retenções** (quantas,
  por organização e motivo, sem expor o conteúdo) e procedimento de recuperação.
  Hoje uma mensagem retida não aparece em lugar nenhum.
- Identidade por escopo empresarial (portfólio/WABA) e contato só por BSUID:
  antes de operar com mais de um portfólio.
- **Retenção incompleta (`size_limited`):** uma mensagem ou contato acima do limite da
  retenção (512 KiB / 16 KiB) guarda só a identificação, o início do texto, o tamanho e
  o sha256 do original; o original só existe no evento bruto, purgado em 30 dias. Quem
  tratar retenções (consulta operacional, recuperação) precisa ler `*_storage` antes de
  reprocessar.
- **Mídias (futuro):** a E2B-2a só guarda o tipo original e a legenda; não baixa nem
  armazena mídia recebida. O tratamento (download pelo id, armazenamento, limite de
  tamanho, tipo permitido) fica para uma entrega própria depois da E2B-2.
- **Entrega 7B e `homolog:e2e`:** o ambiente público com HTTPS (7B, pausada) e a suíte
  `homolog:e2e` (15 falhas anteriores à E2B-1) seguem como estão; a E2B-2a não foi
  homologada com a imagem de produção.
- Débitos não bloqueantes da auditoria: no limite exato de 24 h a tela fecha e o
  banco ainda aceita (desde a 0008); a bolha mostra `created_at`, não o horário
  da Meta; a janela de `cloud_api` percorre as mensagens da conversa (sem
  índice próprio); a legenda de mídia é cortada para caber em 4096; não há
  ligação mensagem → evento (id de mídia e `button.payload` de template só no
  evento bruto); `ingest_inbound_internal` não precisaria ser SECURITY DEFINER.
