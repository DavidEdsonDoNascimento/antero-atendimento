-- Antero Atendimento — Ciclo 2, Etapa 2: RLS e privilégios mínimos
-- Habilita leitura de contacts, conversations e messages apenas para
-- membros ativos da própria organização. Nenhuma escrita direta pela API:
-- toda mutação chega por função restrita, começando pela ingestão atômica
-- da Etapa 3.
--
-- RLS já foi habilitada em 0003_atendimento.sql (imutável — não repetida
-- aqui). Este arquivo cuida de duas camadas independentes, como exigido:
--   1) privilégios SQL — GRANT/REVOKE de tabela, avaliados ANTES de RLS;
--   2) políticas RLS — avaliadas linha a linha, DEPOIS dos privilégios.
-- Nenhuma camada depende só da outra: sem a política, mesmo com GRANT não
-- há linha visível; sem o GRANT, mesmo com política o Postgres nega antes
-- de chegar a avaliar qualquer USING.
--
-- Decisão sobre is_platform_admin: NÃO recebe acesso a estas 3 tabelas.
-- Administração da plataforma (organizações, ativação de contas) é
-- distinta de pertencer a uma organização, e o conteúdo de conversas e
-- mensagens de clientes é sensível. Nenhuma documentação existente exige o
-- contrário (docs/MVP.md restringe a área do admin da plataforma a
-- "lista de organizações"). Reavaliar apenas se um caso de uso concreto de
-- suporte/auditoria for aprovado explicitamente.

-- ---------------------------------------------------------------------------
-- Privilégios de tabela
-- REVOKE ALL (não apenas select/insert/update/delete) para também remover
-- eventuais TRUNCATE/REFERENCES/TRIGGER concedidos por default privileges
-- do projeto Supabase a novas tabelas. anon fica sem nenhum privilégio;
-- authenticated fica só com SELECT — INSERT/UPDATE/DELETE permanecem
-- negados até existir uma função restrita que os exponha deliberadamente.
-- ---------------------------------------------------------------------------
revoke all on
  public.contacts,
  public.conversations,
  public.messages
from anon, authenticated;

grant select on
  public.contacts,
  public.conversations,
  public.messages
to authenticated;

-- ---------------------------------------------------------------------------
-- contacts
-- Leitura para membro ativo da própria organização. is_org_member() já
-- valida auth.uid(), o vínculo com a organização e status = 'active' —
-- membros 'disabled' ou apenas 'invited' não satisfazem a função e,
-- portanto, não veem nenhuma linha. Sem política de INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------
create policy "contacts_select"
  on public.contacts for select
  to authenticated
  using (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- conversations
-- Mesma regra de leitura. owner, admin e attendant não são diferenciados
-- nesta etapa — todo membro ativo lê os dados operacionais da própria
-- organização; diferenças de ação (assumir, responder, resolver) chegam
-- por função/Server Action nos próximos passos do Ciclo 2.
-- ---------------------------------------------------------------------------
create policy "conversations_select"
  on public.conversations for select
  to authenticated
  using (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- messages
-- Mesma regra de leitura. Sem política de INSERT: nem o próprio atendente
-- grava uma mensagem direto na tabela — a gravação (inbound ou outbound)
-- só existirá através da função de ingestão da Etapa 3.
-- ---------------------------------------------------------------------------
create policy "messages_select"
  on public.messages for select
  to authenticated
  using (public.is_org_member(organization_id));
