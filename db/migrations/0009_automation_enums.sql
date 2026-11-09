-- migrate:up
-- Antero Atendimentos — Entrega E3A (1/2): valores de enum do motor de automações.
--
-- Separada de 0010 porque um valor novo de enum não pode ser usado na mesma
-- transação em que foi criado (docs/MODULES.md, "Como adicionar um módulo").
--
--   message_type: `image` (imagem com legenda) e `interactive` (lista de opções)
--     enviados pela automação. O texto legível continua em `content`; a ação
--     completa vai em `messages.payload` (0010).
--   conversation_event_type: `automation_started` (a automação assumiu uma
--     conversa aguardando) e `handed_off` (a automação deixou a conversa para a
--     equipe). Sem usuário: quem age é a automação.

alter type public.message_type add value if not exists 'image';
alter type public.message_type add value if not exists 'interactive';
alter type public.conversation_event_type add value if not exists 'automation_started';
alter type public.conversation_event_type add value if not exists 'handed_off';

-- migrate:down
-- O PostgreSQL não remove valor de enum: o tipo é recriado sem eles. Recusa-se
-- se algum valor desta migration estiver em uso.
do $$
begin
  if exists (select 1 from public.messages where message_type::text in ('image', 'interactive'))
     or exists (select 1 from public.conversation_events where event_type::text in ('automation_started', 'handed_off')) then
    raise exception 'antero_automation: rollback de 0009 recusado: há mensagens ou eventos da automação';
  end if;
end;
$$;

alter type public.message_type rename to message_type_0009;
create type public.message_type as enum ('text');
alter table public.messages alter column message_type drop default;
alter table public.messages
  alter column message_type type public.message_type using message_type::text::public.message_type;
alter table public.messages alter column message_type set default 'text';
drop type public.message_type_0009;

alter table public.conversation_events drop constraint conversation_events_user_matches_type;
alter type public.conversation_event_type rename to conversation_event_type_0009;
create type public.conversation_event_type as enum ('assigned', 'resolved', 'reopened');
alter table public.conversation_events
  alter column event_type type public.conversation_event_type using event_type::text::public.conversation_event_type;
alter table public.conversation_events
  add constraint conversation_events_user_matches_type
  check (
    (event_type <> 'assigned' or user_id is not null)
    and (event_type <> 'reopened' or user_id is null)
  );
drop type public.conversation_event_type_0009;
