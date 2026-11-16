-- migrate:up
-- Antero Atendimentos — Entrega G2A: segurança dos vínculos e das organizações.
--
-- Falhas reproduzidas (claude-reports/2026-11-16-investigacao-g2-vinculos-auditoria.md,
-- db/tests/120_member_rules_test.sql), todas por DML direto de antero_app, que
-- 0002 liberava a `is_org_admin(org) OR is_platform_admin()`:
--   - admin (não owner) se promovia a owner, rebaixava, desativava ou excluía o
--     owner e deixava a organização sem nenhum;
--   - trocava o `user_id` de um vínculo e criava vínculo para usuário de outra
--     empresa com `created_at` antigo, o que mudava a organização ativa dela
--     (`getActiveContext` escolhe o vínculo ativo mais antigo);
--   - o admin da plataforma, sem vínculo, se vinculava a qualquer organização
--     (passando a ler conversas) e criava ou EXCLUÍA organizações (cascata em
--     todos os dados da empresa);
--   - owner/admin renomeavam a própria organização por UPDATE (name), sem
--     tela nem registro (o nome poderia imitar o de outro cliente).
-- Nenhum código da aplicação usa esse DML: vínculos e organizações nascem por
-- operação administrativa fora de antero_app (SETUP.md, fixtures).
--
-- Decisões:
--   - antero_app não escreve em organization_members. As políticas de escrita
--     são removidas (não só ficam sem GRANT), como 0006 fez com
--     whatsapp_accounts: um GRANT futuro não as reativa por engano. Gestão de
--     membros, quando existir, será por função SECURITY DEFINER com regras de
--     papel. Leitura (organization_members_select) não muda.
--   - organizations: antero_app fica só com SELECT. Perde INSERT, DELETE e
--     UPDATE (name), e as políticas de escrita são removidas. Nenhum código
--     usa essas escritas. O status continua por set_organization_status (0006)
--     e os módulos por set_organization_module (0007), funções do admin da
--     plataforma que não dependem desses privilégios. Alterações cadastrais
--     futuras (nome, criação, exclusão) serão operações controladas e
--     auditáveis, por função.
--   - Invariante: uma organização que tem owner ativo não fica sem nenhum por
--     alteração de vínculo. Gatilho no banco, válido para QUALQUER papel
--     (inclusive manutenção como dono das tabelas), ver ensure_active_owner.
--     Não altera dados nem bloqueia organizações que já estão sem owner.

-- ---------------------------------------------------------------------------
-- organization_members: só leitura para a aplicação
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.organization_members from antero_app;

drop policy "organization_members_insert" on public.organization_members;
drop policy "organization_members_update" on public.organization_members;
drop policy "organization_members_delete" on public.organization_members;

-- ---------------------------------------------------------------------------
-- organizations: só leitura para a aplicação
-- ---------------------------------------------------------------------------
revoke insert, delete on public.organizations from antero_app;
revoke update (name) on public.organizations from antero_app;

drop policy "organizations_insert" on public.organizations;
drop policy "organizations_update" on public.organizations;
drop policy "organizations_delete" on public.organizations;

-- ---------------------------------------------------------------------------
-- Pelo menos um owner ativo
--
-- Dispara quando a linha ANTIGA era owner ativo e deixa de ser (rebaixar,
-- desativar, excluir, mover para outra organização). Trava a linha da
-- organização (FOR NO KEY UPDATE, mesmo padrão de set_organization_module) e
-- só então confere, com um snapshot novo, se resta outro owner ativo. Duas
-- transações READ COMMITTED que tiram owners diferentes se serializam na trava:
-- a segunda enxerga a primeira já confirmada e é recusada. SERIALIZABLE
-- detecta o conflito pelo próprio SSI. REPEATABLE READ veria o snapshot antigo
-- depois da trava (e deixaria a organização sem owner), por isso é recusado
-- só nesta operação.
--
-- Organização inexistente na hora da conferência = ela está sendo excluída
-- (cascata): permitido. Organização que já estava sem owner ativo: a linha
-- antiga não era owner ativo, nada é conferido. TRUNCATE não é coberto (só o
-- dono das tabelas o executa).
--
-- SECURITY DEFINER (dono: antero_owner) para travar e ler a organização
-- independentemente de quem altera o vínculo; não recebe argumentos do
-- chamador além das linhas do próprio gatilho.
-- ---------------------------------------------------------------------------
create function public.ensure_active_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' or old.status <> 'active' then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.role = 'owner'
     and new.status = 'active'
     and new.organization_id = old.organization_id then
    return null;
  end if;

  if pg_catalog.current_setting('transaction_isolation') = 'repeatable read' then
    raise exception 'antero_members: isolation_not_supported: alterar owner exige READ COMMITTED ou SERIALIZABLE'
      using errcode = '25001';
  end if;

  perform 1
  from public.organizations o
  where o.id = old.organization_id
  for no key update;

  if not found then
    return null;
  end if;

  if not exists (
    select 1
    from public.organization_members m
    where m.organization_id = old.organization_id
      and m.role = 'owner'
      and m.status = 'active'
  ) then
    raise exception 'antero_members: last_owner: a organização precisa de pelo menos um owner ativo'
      using errcode = '23514',
            hint = 'Torne outro membro owner ativo antes de alterar ou remover este.';
  end if;

  return null;
end;
$$;

revoke all on function public.ensure_active_owner() from public;

create trigger organization_members_ensure_active_owner
after update or delete on public.organization_members
for each row
execute function public.ensure_active_owner();

-- migrate:down
-- Volta exatamente ao estado de 0011 (não apaga nem altera dados).
-- ATENÇÃO: reverter REABRE as falhas descritas acima (escrita direta de
-- antero_app em vínculos e organizações, inclusive renomear) e remove a
-- garantia de owner ativo.
-- Só para recuperação; a correção deve ser reaplicada em seguida.
drop trigger organization_members_ensure_active_owner on public.organization_members;
drop function public.ensure_active_owner();

create policy "organizations_insert"
  on public.organizations for insert
  to antero_app
  with check (public.is_platform_admin());

create policy "organizations_update"
  on public.organizations for update
  to antero_app
  using (public.is_org_admin(id) or public.is_platform_admin())
  with check (public.is_org_admin(id) or public.is_platform_admin());

create policy "organizations_delete"
  on public.organizations for delete
  to antero_app
  using (public.is_platform_admin());

grant insert, delete on public.organizations to antero_app;
grant update (name) on public.organizations to antero_app;

create policy "organization_members_insert"
  on public.organization_members for insert
  to antero_app
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "organization_members_update"
  on public.organization_members for update
  to antero_app
  using (public.is_org_admin(organization_id) or public.is_platform_admin())
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "organization_members_delete"
  on public.organization_members for delete
  to antero_app
  using (public.is_org_admin(organization_id) or public.is_platform_admin());

grant insert, update, delete on public.organization_members to antero_app;
