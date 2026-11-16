-- migrate:up
-- Antero Atendimentos — Entrega E3B: imagens dos fluxos enviadas pelo painel.
--
-- Decisões:
--   - O projeto não tem armazenamento de objetos e o contêiner de produção é
--     efêmero. A menor solução sustentável é o próprio PostgreSQL: já é
--     persistente, tem backup e isola por organização com RLS. Limites pequenos
--     (5 MB por imagem, o máximo da Cloud API para imagem; 100 imagens e 100 MB
--     por organização) mantêm o banco saudável. Trocar por armazenamento de
--     objetos depois muda só onde o arquivo mora: o fluxo guarda o id.
--   - A definição do fluxo guarda só o id (`mediaId`), nunca o arquivo nem
--     base64. Publicar continua criando versão imutável; uma imagem não é
--     apagada nem alterada depois de enviada (uma versão publicada pode usá-la).
--   - Só JPEG e PNG (os formatos de imagem da Cloud API). O tipo é conferido
--     pela assinatura do arquivo aqui também, não pelo que o navegador declara.
--   - Enviar a mesma imagem de novo devolve a existente (sha256 por organização).
--   - Escrita só por save_automation_media: owner/admin ativo, módulo
--     Automações, organização ativa (assert_automation_admin, 0010). Leitura
--     por membro ativo com Automações (editor, prévia) ou Atendimento (Inbox:
--     imagens que a automação enviou).
--   - Envio pela Cloud API (E2C): o provedor carrega o arquivo na Meta
--     (POST /{phone_number_id}/media) e envia pelo id da mídia lá; não é preciso
--     expor a imagem em URL pública.

create table public.automation_media (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  content_type text not null,
  byte_size integer not null,
  sha256 bytea not null,
  data bytea not null,
  file_name text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint automation_media_organization_id_id_key unique (organization_id, id),
  constraint automation_media_sha256_key unique (organization_id, sha256),
  constraint automation_media_content_type check (content_type in ('image/jpeg', 'image/png')),
  constraint automation_media_byte_size
    check (byte_size between 1 and 5242880 and byte_size = octet_length(data)),
  constraint automation_media_sha256_length check (octet_length(sha256) = 32),
  constraint automation_media_file_name_length check (char_length(file_name) between 1 and 200)
);

create index automation_media_organization_created_idx
  on public.automation_media (organization_id, created_at desc, id desc);

alter table public.automation_media enable row level security;

revoke all on public.automation_media from antero_app;
grant select on public.automation_media to antero_app;

create policy "automation_media_select"
  on public.automation_media for select
  to antero_app
  using (
    public.is_org_member(organization_id)
    and (public.has_module(organization_id, 'automacoes') or public.has_module(organization_id, 'atendimento'))
  );

-- Grava uma imagem da organização (ou devolve a mesma, já enviada).
create function public.save_automation_media(
  p_organization_id uuid,
  p_content_type text,
  p_file_name text,
  p_data bytea
)
returns table (media_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public.assert_automation_admin(p_organization_id);
  v_sha bytea;
  v_id uuid;
  v_count integer;
  v_bytes bigint;
begin
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 5242880 then
    raise exception 'antero_automation: media_size: a imagem deve ter até 5 MB'
      using errcode = 'AU011';
  end if;
  if p_content_type is null or p_content_type not in ('image/jpeg', 'image/png')
     or (p_content_type = 'image/jpeg' and pg_catalog.substring(p_data, 1, 3) <> '\xffd8ff'::bytea)
     or (p_content_type = 'image/png' and pg_catalog.substring(p_data, 1, 8) <> '\x89504e470d0a1a0a'::bytea) then
    raise exception 'antero_automation: media_type: só imagens JPEG ou PNG'
      using errcode = 'AU012';
  end if;
  if p_file_name is null or char_length(pg_catalog.btrim(p_file_name)) not between 1 and 200 then
    raise exception 'antero_automation: invalid_input: nome do arquivo inválido'
      using errcode = '22023';
  end if;

  v_sha := pg_catalog.sha256(p_data);
  select m.id into v_id
  from public.automation_media m
  where m.organization_id = p_organization_id and m.sha256 = v_sha;
  if found then
    return query select v_id, false;
    return;
  end if;

  -- Cota por organização. A trava evita que dois envios simultâneos passem juntos.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation_media:' || p_organization_id::text, 0));
  select count(*), coalesce(sum(m.byte_size), 0) into v_count, v_bytes
  from public.automation_media m
  where m.organization_id = p_organization_id;
  if v_count >= 100 or v_bytes + octet_length(p_data) > 104857600 then
    raise exception 'antero_automation: media_quota: limite de imagens da organização atingido'
      using errcode = 'AU013';
  end if;

  insert into public.automation_media as m (
    organization_id, content_type, byte_size, sha256, data, file_name, created_by
  )
  values (
    p_organization_id, p_content_type, octet_length(p_data), v_sha, p_data, pg_catalog.btrim(p_file_name), v_uid
  )
  on conflict (organization_id, sha256) do nothing
  returning m.id into v_id;

  if v_id is null then
    -- Mesmo arquivo gravado por outro envio no meio: devolve o dele.
    select m.id into v_id
    from public.automation_media m
    where m.organization_id = p_organization_id and m.sha256 = v_sha;
    return query select v_id, false;
    return;
  end if;
  return query select v_id, true;
end;
$$;

revoke all on function public.save_automation_media(uuid, text, text, bytea) from public;
grant execute on function public.save_automation_media(uuid, text, text, bytea) to antero_app;

-- migrate:down
-- Recusa-se se houver imagem: reverter apagaria arquivos de clientes que
-- versões publicadas podem estar usando.
do $$
begin
  if exists (select 1 from public.automation_media) then
    raise exception 'antero_automation: rollback de 0011 recusado: há imagens enviadas';
  end if;
end;
$$;

drop function public.save_automation_media(uuid, text, text, bytea);
drop table public.automation_media;
