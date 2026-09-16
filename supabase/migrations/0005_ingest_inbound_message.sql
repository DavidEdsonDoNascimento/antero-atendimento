-- Antero Atendimento — Ciclo 2, Etapa 3: ingestão atômica de mensagens inbound
-- Cria a única porta de escrita para mensagens recebidas nesta etapa:
-- public.ingest_inbound_message(). Nenhuma tabela ganha política de
-- INSERT/UPDATE/DELETE (0004_atendimento_rls.sql permanece válido, intacto);
-- authenticated continua com SELECT apenas nas 3 tabelas do Ciclo 2. Toda
-- escrita passa por esta função SECURITY DEFINER, que roda com os
-- privilégios do owner da migration (mesmo padrão de handle_new_user,
-- is_org_member e is_org_admin em 0001_init.sql) e portanto ignora RLS e os
-- GRANTs do chamador — a autorização de negócio é reimplementada dentro do
-- corpo da função, não herdada de RLS.
--
-- Escopo desta etapa (Ciclo 2, Etapa 3): apenas ingestão. Sem interface, sem
-- DAL, sem Server Actions, sem caixa de entrada, sem ações de atendente, sem
-- integração com a Meta — a função é a única coisa nova aqui.
--
-- Decisão — "conta ativa" e provider "dev" nesta etapa:
-- whatsapp_status só tem os valores ('connected', 'disconnected') e
-- whatsapp_provider só tem ('development', 'cloud_api') — não existe um
-- valor literal 'active' nem 'dev' nestes enums (ver 0001_init.sql). Esta
-- função interpreta "conta ativa" como status = 'connected' e "provider dev"
-- como provider = 'development', únicos valores desses enums compatíveis
-- com a intenção da Etapa 3 (ingestão só a partir de um canal de
-- desenvolvimento já conectado, antes de existir integração real com a
-- Meta/Cloud API). Não confiar em nenhuma proteção futura de interface para
-- impedir chamadas com provider = 'cloud_api': a checagem é feita aqui,
-- dentro da função.
--
-- Autorização do chamador: reaproveita public.is_org_admin(org_id), que já
-- expressa exatamente "owner ou admin ativo da organização" (role in
-- ('owner','admin') and status = 'active') — ver 0001_init.sql. Não há
-- necessidade de duplicar essa regra.
--
-- Idempotência: a UNIQUE PARTIAL INDEX
-- messages_whatsapp_account_external_id_key (0003_atendimento.sql) é a
-- autoridade final contra duplicidade e concorrência — a função nunca conclui
-- "esta mensagem é nova" apenas por não ter encontrado nada em um SELECT
-- prévio. O padrão usado para contacts e conversations é sempre: INSERT ...
-- ON CONFLICT ... DO NOTHING RETURNING ... INTO var; se var ficar NULL, um
-- SELECT subsequente enxerga a linha que "venceu" a corrida (o Postgres
-- serializa por trás do índice único: a segunda transação bloqueia na chave
-- conflitante até a primeira commitar, e só então resolve o conflito ou
-- insere) — não é um "check-then-insert" vulnerável a corrida.
--
-- Correção pontual (revisão pós-Etapa 3, antes da aplicação remota de
-- 0005): a mensagem só era testada contra a UNIQUE depois de já ter
-- localizado/criado contato e conversa. Isso deixava a resposta final
-- correta (duplicate = true, id da mensagem original) mas com efeito
-- colateral real: uma reentrega com o mesmo (whatsapp_account_id,
-- external_message_id) e um TELEFONE DIFERENTE do original criava um
-- contato e uma conversa novos para esse telefone antes de descobrir que a
-- mensagem já existia — reproduzido e confirmado por teste (seção "4b"
-- abaixo) antes desta correção. A duplicidade agora é decidida ANTES de
-- qualquer escrita em contato/conversa, via lock consultivo transacional
-- (ver bloco logo após as validações de entrada).
--
-- Reabertura: quando a mensagem é realmente nova (não duplicata) e a
-- conversa encontrada já existia com status = 'resolved', a linha é travada
-- com SELECT ... FOR UPDATE antes de decidir se reabre. Isso serializa duas
-- mensagens novas concorrentes para a mesma conversa: a segunda só enxerga o
-- estado após a primeira commitar, então nunca tenta reabrir uma conversa
-- que a primeira já reabriu (reopened = true somente na chamada que de fato
-- mudou o status).
--
-- delivery_status escolhido para mensagens inbound: 'delivered', não o
-- default da coluna ('sent'). A coluna message_delivery_status
-- (pending/sent/delivered/read/failed) foi desenhada pensando no ciclo de
-- vida de uma mensagem OUTBOUND que a Antero envia (pending ao enfileirar,
-- sent ao confirmar envio à Meta, delivered/read via webhook de status,
-- failed em erro). Uma mensagem INBOUND já chegou inteira ao nosso sistema
-- quando esta função é chamada — não existe, do nosso lado, um "enviamos e
-- aguardamos confirmação" para ela. 'delivered' é o estado terminal mais
-- correto: a entrega (do contato para a Antero) já se completou. 'sent'
-- sugeriria que fomos nós que enviamos; 'read' implicaria que um atendente
-- já visualizou a mensagem na interface, um conceito de UI fora do escopo
-- desta função; 'pending'/'failed' não fazem sentido para algo que já foi
-- persistido com sucesso.

-- ---------------------------------------------------------------------------
-- public.ingest_inbound_message
--
-- Parâmetros mínimos (ver AGENTS.md / instruções da Etapa 3): a função NUNCA
-- recebe organization_id, conversation_id, status, direction, sender_type,
-- timestamps ou sender_user_id do chamador — todos são derivados ou fixos
-- dentro do corpo. p_contact_name é o único parâmetro opcional e, por regra
-- do Postgres (parâmetros com DEFAULT devem ser os últimos da assinatura),
-- fica na última posição — chame esta função com notação nomeada
-- (`p_whatsapp_account_id => ..., p_contact_name => ...`) para não depender
-- da ordem posicional.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_inbound_message(
  p_whatsapp_account_id uuid,
  p_phone_number text,
  p_content text,
  p_external_message_id text,
  p_contact_name text default null
)
returns table (
  organization_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  created boolean,
  duplicate boolean,
  reopened boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
-- RETURNS TABLE cria parâmetros OUT implícitos chamados organization_id,
-- contact_id, conversation_id, message_id, created, duplicate, reopened —
-- três deles (organization_id, contact_id, conversation_id) têm o MESMO
-- nome de colunas reais de contacts/conversations/messages. Sem este pragma,
-- qualquer INSERT/ON CONFLICT/WHERE abaixo que mencione essas colunas por
-- nome simples vira "ambíguo: variável do PL/pgSQL ou coluna da tabela?" e
-- falha em tempo de execução. use_column resolve sempre a favor da coluna
-- da tabela; o corpo desta função nunca lê/escreve os parâmetros OUT pelo
-- nome — só usa as variáveis locais v_organization_id/v_contact_id/
-- v_conversation_id abaixo, coladas no resultado apenas no RETURN QUERY
-- final — então este pragma não muda nenhum comportamento pretendido.
declare
  v_uid uuid;
  v_organization_id uuid;
  v_account_status public.whatsapp_status;
  v_account_provider public.whatsapp_provider;
  v_phone_number text := p_phone_number;
  v_content text := trim(p_content);
  v_external_message_id text := trim(p_external_message_id);
  v_contact_name text := nullif(trim(coalesce(p_contact_name, '')), '');
  v_contact_id uuid;
  v_conversation_id uuid;
  v_conversation_status public.conversation_status;
  v_message_id uuid;
  v_created boolean := false;
  v_duplicate boolean := false;
  v_reopened boolean := false;
  v_lock_key bigint;
  v_existing_message_id uuid;
  v_existing_conversation_id uuid;
  v_existing_organization_id uuid;
begin
  -- 1) usuário autenticado
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'antero_ingest: not_authenticated: chamada requer usuário autenticado'
      using errcode = '28000';
  end if;

  -- 2) conta existente e ativa + 3) provider dev
  -- (whatsapp_accounts.id é primary key: no máximo uma linha, SELECT INTO
  -- sem STRICT já cobre "não encontrado" via FOUND, sem lançar erro à toa.)
  select w.organization_id, w.status, w.provider
    into v_organization_id, v_account_status, v_account_provider
  from public.whatsapp_accounts w
  where w.id = p_whatsapp_account_id;

  if not found then
    raise exception 'antero_ingest: account_not_found: whatsapp_account % não existe', p_whatsapp_account_id;
  end if;

  if v_account_status <> 'connected' then
    raise exception 'antero_ingest: account_inactive: whatsapp_account % não está ativa (status=%)',
      p_whatsapp_account_id, v_account_status;
  end if;

  if v_account_provider <> 'development' then
    raise exception 'antero_ingest: account_wrong_provider: whatsapp_account % não é provider development (provider=%)',
      p_whatsapp_account_id, v_account_provider;
  end if;

  -- 4) autorização por organização: chamador deve ser owner/admin ativo
  if not public.is_org_admin(v_organization_id) then
    raise exception 'antero_ingest: not_authorized: usuário % não é owner/admin ativo da organização %',
      v_uid, v_organization_id
      using errcode = '42501';
  end if;

  -- 5) telefone em E.164 (mesma forma exigida por contacts_phone_number_format
  -- em 0003_atendimento.sql — a constraint continua sendo a autoridade final;
  -- esta checagem só antecipa um erro claro em vez de um erro genérico de
  -- violação de constraint)
  if v_phone_number !~ '^\+[1-9][0-9]{1,14}$' then
    raise exception 'antero_ingest: invalid_phone_number: telefone % não está em E.164', v_phone_number;
  end if;

  -- 6)/7) conteúdo após trim, não vazio e dentro do limite (mesmo limite de
  -- messages_content_length em 0003_atendimento.sql)
  if char_length(v_content) = 0 then
    raise exception 'antero_ingest: empty_content: conteúdo da mensagem está vazio após trim';
  end if;

  if char_length(v_content) > 4096 then
    raise exception 'antero_ingest: content_too_long: conteúdo da mensagem excede 4096 caracteres';
  end if;

  -- 8) external_message_id obrigatório e não vazio
  if p_external_message_id is null or char_length(v_external_message_id) = 0 then
    raise exception 'antero_ingest: missing_external_message_id: external_message_id é obrigatório e não pode ser vazio';
  end if;

  -- ---------------------------------------------------------------------
  -- Lock consultivo TRANSACIONAL (pg_advisory_xact_lock), chave
  -- determinística derivada do PAR que a UNIQUE parcial protege:
  -- (whatsapp_account_id, external_message_id). Adquirido ANTES de tocar em
  -- contato ou conversa — é essa ordem que evita o efeito colateral: sem o
  -- lock, uma reentrega com o mesmo par mas telefone/nome/conteúdo
  -- diferentes só seria detectada como duplicata no INSERT de messages, já
  -- depois de ter localizado/criado contato e conversa para o telefone
  -- novo (confirmado por teste antes desta correção).
  --
  -- hashtextextended(text, seed bigint) é built-in do Postgres (pg_catalog,
  -- por isso chamado sem qualificação mesmo com search_path = '' — o
  -- pg_catalog é sempre pesquisado implicitamente) e devolve bigint, o tipo
  -- exigido pelo overload pg_advisory_xact_lock(bigint). O ':' como
  -- separador nunca é ambíguo: p_whatsapp_account_id::text é sempre um uuid
  -- bem formado (só hifens), que nunca contém ':'.
  --
  -- Por que chamadas com o MESMO par ficam serializadas: hashtextextended é
  -- uma função determinística — duas chamadas com a mesma
  -- (whatsapp_account_id, external_message_id) sempre calculam a mesma
  -- v_lock_key. pg_advisory_xact_lock bloqueia a segunda chamada até a
  -- primeira liberar essa chave; quando a segunda finalmente adquire o
  -- lock, sua consulta abaixo já enxerga (READ COMMITTED, nova instantânea
  -- por comando) a mensagem que a primeira gravou, se foi o caso.
  --
  -- Por que uma colisão de hash (pares DIFERENTES caindo na mesma chave)
  -- não compromete a integridade: o lock é só um mutex de conveniência para
  -- evitar trabalho e escrita órfã no caminho comum — nunca é ele quem
  -- decide "isto é duplicata". Quem decide é a consulta a public.messages
  -- logo abaixo, filtrada pelas colunas reais (whatsapp_account_id,
  -- external_message_id), e, como cinturão e suspensório, a própria UNIQUE
  -- parcial no INSERT mais adiante. Uma colisão faria, no pior caso, duas
  -- chamadas para pares diferentes esperarem uma pela outra sem necessidade
  -- — mais lento, nunca incorreto.
  --
  -- Por que o lock é liberado sozinho: pg_advisory_xact_lock (variante
  -- "_xact", não a de sessão) prende ao final da transação atual —
  -- Postgres libera automaticamente em COMMIT ou ROLLBACK, inclusive se
  -- esta função levantar exceção mais adiante. Não há UNLOCK explícito, e
  -- não usamos pg_advisory_lock (o de sessão, que precisaria de
  -- pg_advisory_unlock manual e sobreviveria a esta transação).
  --
  -- Por que a UNIQUE parcial continua necessária mesmo com o lock: o lock
  -- só serializa chamadas desta função entre si. Não é ele quem impede uma
  -- violação de integridade no banco — quem impede é a constraint,
  -- independente de qualquer disciplina de locking na aplicação (inclusive
  -- se um dia outro caminho de escrita, um bug, ou uma sessão que calcule a
  -- chave errada, tentar inserir sem passar por aqui). Por isso o INSERT de
  -- mensagem mais abaixo mantém ON CONFLICT ... DO NOTHING como autoridade
  -- final — na prática, dado o lock, o "ON CONFLICT" ali não deveria mais
  -- disparar para chamadas que passam por esta função, mas continua sendo a
  -- garantia real.
  -- ---------------------------------------------------------------------
  v_lock_key := hashtextextended(p_whatsapp_account_id::text || ':' || v_external_message_id, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Variáveis DEDICADAS para esta consulta (v_existing_*, não
  -- v_organization_id/v_conversation_id/v_message_id): um SELECT INTO sem
  -- STRICT zera TODOS os seus alvos para NULL quando não encontra linha —
  -- não apenas deixa de atribuí-los. Se esta consulta reaproveitasse
  -- v_organization_id (já preenchido pela busca da conta, logo acima) e
  -- caísse no caminho comum de "mensagem realmente nova" (nenhuma linha
  -- encontrada), v_organization_id seria zerado para NULL e o INSERT em
  -- contacts logo abaixo violaria a NOT NULL — bug real, pego pelo teste
  -- "fluxo completo" (seção 1) ao aplicar esta correção antes de testar.
  select m.id, m.conversation_id, m.organization_id
    into v_existing_message_id, v_existing_conversation_id, v_existing_organization_id
  from public.messages m
  where m.whatsapp_account_id = p_whatsapp_account_id
    and m.external_message_id = v_external_message_id;

  if found then
    -- Duplicata detectada ANTES de qualquer escrita em contato/conversa:
    -- nada foi criado ou alterado para o payload desta chamada (telefone,
    -- nome, conteúdo) — apenas devolvemos os IDs da mensagem original.
    select c.contact_id into v_contact_id
    from public.conversations c
    where c.organization_id = v_existing_organization_id
      and c.id = v_existing_conversation_id;

    return query
    select
      v_existing_organization_id,
      v_contact_id,
      v_existing_conversation_id,
      v_existing_message_id,
      false,
      true,
      false;
    return;
  end if;

  -- ---------------------------------------------------------------------
  -- Contato: localizar ou criar por (organization_id, phone_number).
  -- ON CONFLICT DO NOTHING é a defesa contra criação concorrente do mesmo
  -- contato — a UNIQUE (organization_id, phone_number) de
  -- contacts_organization_id_phone_number_key é quem decide, não este SELECT.
  -- Entregas duplicadas (e qualquer chamada em que o contato já existe) NUNCA
  -- atualizam o contato: não há UPDATE de name aqui de propósito, o que
  -- também garante, por construção, que um nome existente nunca é
  -- substituído por vazio.
  -- ---------------------------------------------------------------------
  insert into public.contacts (organization_id, phone_number, name)
  values (v_organization_id, v_phone_number, v_contact_name)
  on conflict (organization_id, phone_number) do nothing
  returning id into v_contact_id;

  if v_contact_id is null then
    select c.id into v_contact_id
    from public.contacts c
    where c.organization_id = v_organization_id
      and c.phone_number = v_phone_number;
  end if;

  -- ---------------------------------------------------------------------
  -- Conversa: localizar ou criar por (organization_id, whatsapp_account_id,
  -- contact_id). Mesmo padrão de upsert seguro contra concorrência.
  -- Quando a conversa já existia, trava a linha com FOR UPDATE: sob READ
  -- COMMITTED, se outra transação está no meio de reabrir esta mesma
  -- conversa, esta espera o commit e então lê o status JÁ ATUALIZADO — nunca
  -- decide reabrir com base em um status obsoleto.
  -- ---------------------------------------------------------------------
  insert into public.conversations (organization_id, whatsapp_account_id, contact_id)
  values (v_organization_id, p_whatsapp_account_id, v_contact_id)
  on conflict (organization_id, whatsapp_account_id, contact_id) do nothing
  returning id, status into v_conversation_id, v_conversation_status;

  if v_conversation_id is null then
    select c.id, c.status
      into v_conversation_id, v_conversation_status
    from public.conversations c
    where c.organization_id = v_organization_id
      and c.whatsapp_account_id = p_whatsapp_account_id
      and c.contact_id = v_contact_id
    for update;
  end if;

  -- ---------------------------------------------------------------------
  -- Mensagem: a UNIQUE PARTIAL INDEX messages_whatsapp_account_external_id_key
  -- é a autoridade final de idempotência. ON CONFLICT DO NOTHING nunca
  -- levanta exceção de duplicidade — apenas não insere, e o ramo abaixo
  -- distingue "criada" de "duplicata" olhando se v_message_id veio da
  -- própria inserção.
  --
  -- Dado o lock consultivo acima, uma chamada que chega até aqui já provou,
  -- sob a mesma chave (whatsapp_account_id, external_message_id), que
  -- nenhuma mensagem para este par existia no momento em que adquiriu o
  -- lock — então, para chamadas que passam por esta função, o ramo
  -- "v_message_id is null" abaixo não deveria mais disparar na prática.
  -- Mantido mesmo assim como cinturão e suspensório: é a UNIQUE, não o
  -- lock, quem de fato impede duas linhas para o mesmo par (ver nota acima
  -- sobre por que o lock não substitui a constraint).
  -- ---------------------------------------------------------------------
  insert into public.messages (
    organization_id,
    conversation_id,
    whatsapp_account_id,
    external_message_id,
    direction,
    sender_type,
    sender_user_id,
    message_type,
    content,
    delivery_status
  )
  values (
    v_organization_id,
    v_conversation_id,
    p_whatsapp_account_id,
    v_external_message_id,
    'inbound',
    'contact',
    null,
    'text',
    v_content,
    'delivered'
  )
  on conflict (whatsapp_account_id, external_message_id) where external_message_id is not null
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    -- Duplicata: a mensagem já existe. Não reabre conversa, não altera
    -- status, não altera atribuição, não avança last_message_at, não altera
    -- contato, não cria outra mensagem. Os IDs retornados vêm da mensagem
    -- realmente persistida (e da conversa/organização a que ela pertence de
    -- fato), não dos valores computados acima — defesa extra caso o mesmo
    -- external_message_id um dia apareça associado a um contato diferente
    -- na mesma conta (anomalia do provedor, não esperada em operação normal).
    v_duplicate := true;
    v_created := false;
    v_reopened := false;

    select m.id, m.conversation_id, m.organization_id
      into v_message_id, v_conversation_id, v_organization_id
    from public.messages m
    where m.whatsapp_account_id = p_whatsapp_account_id
      and m.external_message_id = v_external_message_id;

    select c.contact_id
      into v_contact_id
    from public.conversations c
    where c.organization_id = v_organization_id
      and c.id = v_conversation_id;
  else
    -- Mensagem nova de verdade: decide reabertura e atualiza atividade.
    v_created := true;
    v_duplicate := false;
    v_reopened := (v_conversation_status = 'resolved');

    if v_reopened then
      update public.conversations
      set status = 'waiting',
          resolved_at = null,
          assigned_user_id = null,
          assigned_at = null,
          last_message_at = now()
      where organization_id = v_organization_id
        and id = v_conversation_id;
    else
      -- Conversas 'waiting', 'human' ou 'bot' (ou a recém-criada, que já
      -- nasce 'waiting') não mudam de status aqui — só a atividade avança.
      update public.conversations
      set last_message_at = now()
      where organization_id = v_organization_id
        and id = v_conversation_id;
    end if;
  end if;

  return query
  select
    v_organization_id,
    v_contact_id,
    v_conversation_id,
    v_message_id,
    v_created,
    v_duplicate,
    v_reopened;
end;
$$;

-- ---------------------------------------------------------------------------
-- Segurança: sem EXECUTE para public/anon, somente authenticated.
-- Duas fontes de concessão implícita precisam ser revogadas, não uma só:
-- 1) CREATE FUNCTION concederia EXECUTE a PUBLIC por padrão em Postgres puro
--    — não observado aqui porque o cluster do Supabase já roda
--    ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
--    globalmente; o REVOKE abaixo é mantido mesmo assim, defensivo e
--    explícito, para não depender silenciosamente dessa configuração de
--    cluster.
-- 2) O Supabase concede EXECUTE em toda função nova do schema public
--    diretamente a anon, authenticated e service_role (mecanismo equivalente
--    ao "auto_expose_new_tables" do config.toml, também citado ali como
--    válido para "functions"). Essa concessão é direta a cada role, não via
--    PUBLIC — por isso revogar de PUBLIC não basta: o REVOKE de anon abaixo
--    é o que de fato remove o acesso. service_role não é tocado aqui: é o
--    papel de confiança usado só no servidor, nunca exposto a um cliente
--    autenticado como usuário final, e a instrução desta etapa restringe
--    apenas public/anon.
-- ---------------------------------------------------------------------------
revoke all on function public.ingest_inbound_message(uuid, text, text, text, text) from public;
revoke all on function public.ingest_inbound_message(uuid, text, text, text, text) from anon;
grant execute on function public.ingest_inbound_message(uuid, text, text, text, text) to authenticated;
