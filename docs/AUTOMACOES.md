# Automações (E3A)

Motor genérico de fluxos de atendimento automatizado, executado hoje pelo
simulador. Vale para qualquer organização com o módulo Automações: um fluxo é
dado (JSON versionado), não código. Nenhuma regra, id ou texto de cliente está
no motor.

## Peças

| Peça | Onde | O que faz |
| --- | --- | --- |
| Definição | `modules/automations/definition.ts` | Schema Zod (`schemaVersion: 1`), limites do WhatsApp, referências entre etapas, ciclos sem pausa |
| Motor | `modules/automations/engine.ts` | `startSession(def, entrada, ctx)` e `advance(def, estado, entrada, ctx)` → `{ status, state, outputs, reason }`. Puro e determinístico: sem I/O, relógio ou aleatoriedade |
| Ações | `modules/automations/actions.ts` | `text`, `image`, `list` — o que enviar, sem saber como; `toMessageRecord` gera o texto do histórico |
| Cloud API | `modules/messaging/cloud-api.ts` | Corpo de `/messages` para cada ação e leitura de `list_reply`, sem transporte |
| Executor | `modules/automations/runner.ts` | prepare → motor → commit (uma transação) → provedor → resultado do envio |
| Configuração | `modules/automations/sql-commands.ts` | `saveFlowDraft`, `publishFlow`, `setFlowStatus` (contrato do editor E3B) |
| Banco | `db/migrations/0009`, `0010` | Fluxos, versões, sessões, execuções, funções e RLS |

## Tipos de etapa

| Tipo | Espera o cliente | Comportamento |
| --- | --- | --- |
| `message` | não | Envia texto e segue para `next` |
| `image` | não | Envia imagem (`https`) com legenda opcional e segue |
| `menu` | sim | Lista interativa; opções com **id estável**, título (24), descrição (72), até 10 linhas somando "Voltar" e "Menu principal" |
| `question` | sim | Coleta texto (`minLength`/`maxLength`) em `variable`, com o `label` que o atendente vê |
| `handoff` | — | Encerra a automação e passa a conversa para a equipe |
| `end` | — | Conclui com texto opcional |

A escolha num menu é reconhecida por: seleção da lista (id), número mostrado,
id, título ou palavra-chave da opção — sem acento e sem pontuação. A
interpretação usa o id, nunca a posição: reordenar opções não muda o destino de
uma seleção.

Comandos globais (`settings`): pedido de atendente (`humanKeywords`; em menu,
contido na frase; em pergunta, só a resposta inteira, para não sequestrar texto
livre), "menu" (principal) e "voltar" (menu anterior; de uma pergunta, o menu que
a abriu).

Proteções: `maxInvalidAttempts` (padrão 2: repete uma vez e encaminha),
`maxTurns` por sessão (padrão 50), até 20 etapas e 6 mensagens por resposta, e
recusa na publicação de ciclos só de `message`/`image`. Falha do motor, definição
ou estado inválido → sessão `failed`, nenhuma mensagem.

## Definição e versionamento

- `automation_flows`: organização, `slug` (identificador), nome, `status`
  (`draft`/`active`/`paused`), `is_entry` (um por organização), rascunho
  (`draft_definition`, `draft_revision`), versão publicada, responsáveis e datas.
- `automation_flow_versions`: cada publicação, **imutável** (gatilho `AU010`,
  inclusive para o dono das tabelas).
- Publicar confere a revisão do rascunho que a aplicação validou (`AU002` se mudou).
- A sessão guarda `flow_version_id`: publicar de novo não muda uma conversa em
  andamento; conversas novas usam a versão nova.

Escolha: JSON versionado em vez das 5 tabelas previstas no Ciclo 3. Uma
publicação vira uma linha atômica, a sessão se prende a ela sem cópia, e o
editor (E3B) monta o JSON com o mesmo schema que o motor lê — a prévia roda o
mesmo `advance`. O banco confere só o estrutural (objeto, `schemaVersion`,
tamanho); a forma completa é do Zod, aplicado ao gravar, ao publicar e de novo
ao executar.

## Quando a automação age

Decidido por `automation_prepare_internal`, com a conversa travada:

| Situação | Resultado |
| --- | --- |
| Organização suspensa | nada (nem escrita) |
| Mensagem já processada | nada (`already_processed`) |
| Sessão ativa, Automações desligado | sessão `interrupted` (`module_disabled`), conversa volta a `waiting`, nada enviado |
| Sessão ativa, fluxo pausado | idem, `flow_paused` |
| Sessão ativa, mensagem mais antiga que a última processada | nada (`stale`) |
| Sessão ativa, conversa `bot` | **avança** |
| Sem sessão: conversa `waiting`, sem responsável, primeira mensagem do ciclo, ciclo sem sessão, fluxo de entrada ativo | **começa** (conversa → `bot`) |
| Qualquer outro caso (`human`, `resolved`, `waiting` depois de encaminhamento) | nada |

"Ciclo" = desde a criação da conversa ou da última reabertura
(`conversation_events.reopened`). Por isso uma conversa encaminhada nunca
reinicia o robô, e uma conversa resolvida que o cliente reabre começa de novo.

## Sessões e idempotência

`automation_sessions`: fluxo, versão, conversa, etapa atual, `state` (pilha de
menus, tentativas, respostas coletadas em ordem), `status`
(`active`/`handed_off`/`completed`/`interrupted`/`failed`), `revision`,
última mensagem processada, início, atualização, fim e motivo. Uma ativa por
conversa (índice único parcial). Sobrevive a reinício: nada fica em memória.

`automation_executions`: uma linha por mensagem recebida processada, `UNIQUE
(message_id)`. Reentrega da mesma mensagem → `already_processed`, sem nova
resposta. Duas mensagens simultâneas: a conversa é travada (`FOR UPDATE`) do
prepare ao COMMIT; a segunda espera e lê o estado novo, e o commit ainda
confere sessão, revisão e versão (`AU005`). Se a mais nova ganhar a trava, a
mais antiga é ignorada como `stale`.

## Mensagens

Respostas da automação são mensagens comuns em `messages`: `outbound`,
`sender_type = 'bot'`, sem `sender_user_id`, `message_type` `text`/`image`/
`interactive`, `payload` com a ação completa e `automation_execution_id`. Não há
tabela paralela. Envio em duas fases como na E2A: `pending` no commit, provedor
fora da transação, `dev_automation_record_delivery` grava `sent`/`failed`. A
Inbox mostra "Automação" (cor própria) e "simulada" em canal de desenvolvimento.

## Encaminhamento humano

- Sessão `handed_off`, conversa `bot → waiting` sem responsável; evento
  `handed_off` sem usuário. O histórico fica intacto.
- A Inbox mostra "Dados coletados pela automação" (rótulo e valor, na ordem). A
  política de `automation_sessions` aceita Atendimento **ou** Automações.
- Qualquer saída de `bot` que não seja da própria automação (assumir) interrompe
  a sessão por gatilho (`human_takeover`). O robô não responde em `human` nem em
  `waiting` pós-encaminhamento.

### Sem o módulo Atendimento

Os módulos são independentes; o motor recebe `humanHandoffAvailable`:

- etapa `handoff` → envia `unavailableText` (ou `settings.handoffUnavailableMessage`)
  e segue para `unavailableNext`; sem destino, conclui;
- pedido avulso de atendente → avisa e repete a etapa atual;
- respostas inválidas esgotadas → avisa e conclui.

Concluir resolve a conversa (`bot → resolved`, evento sem usuário); a próxima
mensagem do cliente reabre e recomeça o fluxo. O banco recusa `handed_off` sem
Atendimento (`AU008`), então um encaminhamento impossível não chega a existir.
Um fluxo de FAQ que termina em `end` não depende de humano.

## Segurança

- Configurar: `save_automation_flow`, `publish_automation_flow`,
  `set_automation_flow_status` — owner/admin com `has_module(org, 'automacoes')`.
- Executar: funções `*_internal` **sem EXECUTE** para nenhum papel. A única porta
  hoje é `dev_automation_*`: usuário autenticado, owner/admin ativo da
  organização da mensagem (organização ativa) e canal `development` (`AU009`
  para `cloud_api`). Não alcança cliente real em produção.
- Nada é gravado em nome de quem disparou: mensagens `bot`, eventos sem usuário.
  A sessão de um administrador não é a identidade da automação.
- Módulos lidos direto de `organization_modules` na execução (não `has_module`,
  que responde pelo usuário da transação).
- RLS: fluxos, versões e execuções exigem membro + Automações; sessões, membro +
  (Automações ou Atendimento). `antero_app` só lê.
- O executor recusa fora de `NODE_ENV` development/test; o simulador e o fluxo
  demonstrativo ficam fora do `next build` e da imagem (`.dockerignore`).

### Limite até a E2B

O worker e o webhook (E2B) terão papel próprio (ex.: `antero_worker`, sem
BYPASSRLS) e uma porta `worker_automation_*` sobre as mesmas funções internas,
com a organização derivada do canal `cloud_api`. A porta de desenvolvimento não
deve ser afrouxada para isso.

## Recusas (SQLSTATE)

| Código | Motivo |
| --- | --- |
| `AU001` | já existe outro fluxo de entrada |
| `AU002` | o rascunho mudou depois de validado |
| `AU003` | definição malformada |
| `AU004` | ativar fluxo nunca publicado |
| `AU005` | sessão, revisão ou versão mudou desde a leitura |
| `AU006` | a mensagem não é mais elegível (outra execução venceu) |
| `AU007` | resultado do motor malformado |
| `AU008` | encaminhar sem o módulo Atendimento |
| `AU009` | porta de desenvolvimento em canal real |
| `AU010` | alterar versão publicada |

## Usar no desenvolvimento

1. Habilite Automações para a organização em `/admin`.
2. Em `/simulador`, card "Automação (dev)" → "Instalar fluxo demonstrativo"
   (`modules/simulator/demo-flow.ts`, espaço fictício "Recanto Exemplo").
3. Envie mensagens como cliente; as respostas aparecem no simulador (opções
   como atalhos) e na Inbox.

## Pendências

- Entrada `selection` (id da lista) já existe no motor; o simulador e a ingestão
  ainda gravam só texto. A leitura de `list_reply` entra com a E3C.
- Mensagem processada fora de ordem (corrida): a mais antiga é ignorada.
- Resposta `pending` depois de queda entre envio e resultado: como na E2A, é do worker.
- Sem Atendimento, uma conversa já em `waiting` (por exemplo, encaminhada antes
  de desligarem o módulo) não volta para o robô sozinha.
- Desligar Automações interrompe a sessão na próxima mensagem, não no ato.
