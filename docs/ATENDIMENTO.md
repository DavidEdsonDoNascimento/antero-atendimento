# Atendimento humano (E2A)

Inbox funcional sobre o núcleo `contacts`, `conversations` e `messages`, com
mensagens recebidas pelo simulador. Vale para qualquer organização com o módulo
Atendimento habilitado: nenhuma regra é específica de cliente.

## Estados e transições

Estados (`conversation_status`, 0003): `bot`, `waiting`, `human`, `resolved`. As
transições estão nas funções de `db/migrations/0008_conversation_actions.sql`;
nenhuma foi alterada em relação ao modelo anterior, só passou a existir.

| Operação | De | Para | Quem | Repetida |
| --- | --- | --- | --- | --- |
| Assumir (`claim_conversation`) | `waiting`, `bot` (sem responsável) | `human`, responsável = quem assumiu | qualquer membro ativo | sem efeito (`changed = false`) |
| Responder (`send_conversation_reply`) | `human` | `human` | só o responsável, dentro da janela | mesma chave devolve a mensagem já gravada |
| Resolver (`resolve_conversation`) | `human` | `resolved` (responsável mantido) | responsável, owner ou admin | sem efeito |
| Reabrir (`ingest_inbound_message`, 0005) | `resolved` | `waiting`, sem responsável | nova mensagem do cliente | reentrega (mesmo id externo) não reabre |

Recusas, com SQLSTATE próprio (mapeados em `modules/conversations/attendance.ts`):

| SQLSTATE | Motivo |
| --- | --- |
| `28000` / `42501` | sem sessão / sem vínculo ativo, organização suspensa ou sem módulo Atendimento |
| `P0002` | conversa (ou mensagem) inexistente **nesta** organização |
| `AT001` | conversa já está com outro atendente |
| `AT002` | estado não permite (ex.: assumir resolvida, responder aguardando) |
| `AT003` | não é o responsável |
| `AT004` | janela de 24 h encerrada |
| `AT005` | conteúdo vazio ou acima de 4096 caracteres |
| `AT006` | chave de envio já usada por outro autor |
| `AT007` | canal desconectado |
| `AT008` | resultado de envio de canal real gravado pelo usuário |

Não há transferência entre atendentes: uma conversa com responsável só volta a
ficar livre ao ser resolvida e reaberta pelo cliente.

## Concorrência e idempotência

- Toda operação trava a linha da conversa (`FOR UPDATE`). Dois atendentes
  assumindo ao mesmo tempo: o segundo espera o COMMIT do primeiro e recebe
  `AT001` (testado com duas conexões reais em `tests/db/conversation-actions.test.ts`).
- Envio: a tela gera `client_message_id` por mensagem escrita. Duplo clique ou
  nova tentativa levam a mesma chave e o banco não grava outra mensagem
  (índice único por conversa).
- Mensagem recebida duplicada: idempotência da ingestão por
  `(canal, external_message_id)`, sem transição nem evento.

## Janela de atendimento

Respostas de texto livre só até 24 h depois da última mensagem **recebida** do
cliente — a regra da Cloud API para mensagens fora de template. O banco recusa
com o próprio relógio (`AT004`); a tela mostra o aviso e desabilita o campo.
Templates (utilidade/marketing) não fazem parte desta entrega.

## Envio e provedor

`modules/messaging/provider.ts` define `MessagingProvider.sendText`. O envio tem
duas fases, como terá com a Cloud API, sem chamada externa dentro de transação:

1. `send_conversation_reply` grava a mensagem `pending`;
2. o provedor do canal envia (`development` → simulado, sem rede nem token; id
   externo `sim-out-…`);
3. `record_outbound_result` grava `sent` (com o id externo) ou `failed`.

`cloud_api` ainda não tem provedor: a resposta é recusada antes de gravar. Nesta
entrega `record_outbound_result` só aceita canais `development`, para o usuário
não conseguir marcar como enviada uma mensagem de canal real. Mensagens de canal
`development` aparecem como **simuladas** na Inbox, nunca como entregues pelo
WhatsApp.

## Registro do atendimento

`conversation_events` guarda quem assumiu (`assigned`), quem resolveu
(`resolved`) e quando a conversa reabriu (`reopened`, sem usuário: foi o
cliente). É preenchida por gatilho em `conversations`, então nenhum caminho de
escrita escapa — inclusive a ingestão, que não mudou. Quem respondeu está em
`messages.sender_user_id`. A RLS exige vínculo ativo e o módulo Atendimento. Não
é a auditoria administrativa (E1C).

## Simulador de mensagens

`/simulador` (atalho "Simulador (dev)" na Inbox) envia mensagens como se fossem
de um cliente:

- canal: os canais `development` conectados das organizações em que o usuário é
  owner/admin ativo (a Inbox mostra só a organização ativa);
- contato: escolha um da lista do canal ou informe telefone (E.164) e nome;
- "Reenviar a mesma mensagem" repete o id externo e simula a reentrega da Meta.

A mensagem entra por `ingest_inbound_message`, a mesma porta que a ingestão real
reutilizará (E2B): organização derivada do canal, owner/admin ativo,
organização ativa.

Só existe em desenvolvimento e testes, em três camadas:

1. a página é `page.dev.tsx`: `next.config.ts` só inclui a extensão `dev.tsx` na
   fase `next dev`, então `next build` não gera a rota (conferido no build
   isolado e em `src/lib/dev-environment.test.ts`);
2. a página e a Server Action recusam fora de `NODE_ENV` development/test
   (`lib/dev-environment.ts`, que vira constante `false` no build);
3. `.dockerignore` deixa os arquivos do simulador fora do contexto da imagem.

## Atualização da tela

Sem WebSocket: as ações revalidam `/conversas`, e a Inbox pede os dados de novo a
cada 15 s com a aba visível (`AutoRefresh`), preservando o texto em edição.

## Pendências conhecidas (fora da E2A)

Decisões deixadas de propósito; nenhuma tem tratamento hoje.

1. **Mensagens `pending` depois de falha.** O envio é em duas fases (gravar
   `pending`, enviar, gravar o resultado). Se o processo cair, ou o resultado não
   puder ser gravado, entre a fase 1 e a 3, a mensagem fica `pending` ("Enviando…"
   na tela) para sempre: nada a reenvia nem a marca como `failed`. Também não há
   nova tentativa automática para `failed`; o atendente escreve de novo, com outra
   chave. O reprocessamento é do worker (E2B), que também passa a gravar
   `sent/delivered/read/failed` dos canais reais por papel próprio — hoje
   `record_outbound_result` só atende canais `development`, chamado pelo usuário.
2. **Transferência entre atendentes.** Não existe. `claim_conversation` recusa
   (`AT001`) conversa com outro responsável, nem owner/admin toma a conversa, e o
   responsável só muda quando a conversa é resolvida e reaberta pelo cliente.
   Decidir o fluxo (quem pode transferir, para quem, o que o registro mostra) e
   acrescentar um tipo de evento em migration própria.
3. **Responsável desativado.** Se o vínculo do responsável vira `disabled`, a
   conversa continua `human` e atribuída a ele: ninguém assume nem responde (`AT001`/
   `AT003`), e só owner/admin consegue resolvê-la. A tela mostra "Membro sem vínculo
   ativo" (a RLS oculta o perfil), e `organization_members` não pode ser apagado
   enquanto referenciado. Decidir se a desativação libera as conversas dele
   (voltando a `waiting`) ou se o owner/admin as reatribui, junto com o item 2.
