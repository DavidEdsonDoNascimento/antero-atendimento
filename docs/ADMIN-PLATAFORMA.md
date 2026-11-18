# Administração da plataforma (central de organizações, G1)

Área só para quem tem `profiles.is_platform_admin` (equipe da Antero). Serve para
consultar e administrar as organizações clientes. **Não é um modo de suporte**: abrir
uma organização aqui não dá acesso aos dados dela.

## Rotas

| Rota | O que mostra |
| --- | --- |
| `/admin` | Lista de organizações com busca (`?busca=`, nome ou identificador, sem acento nem caixa) e filtro de situação (`?situacao=active\|inactive`); módulos habilitados; suspender e reativar |
| `/admin/organizacoes/[id]` | Dados cadastrais, situação (suspender/reativar), módulos (habilitar/desabilitar), acesso ao histórico, equipe com papéis e situação, canal de atendimento |
| `/admin/organizacoes/[id]/atividades` | Histórico de atividades administrativas da organização (G2C) |
| `/admin/atividades` | Histórico de todas as organizações, com filtro por organização, inclusive excluídas (G2C) |

Busca e filtros vão na URL (formulário GET e links), então a página pode ser recarregada
e compartilhada. Valores desconhecidos são ignorados, nunca erro (`modules/organizations/search.ts`).
Id inválido ou inexistente → "Organização não encontrada" (404).

O cabeçalho mostra "Administração da plataforma" e não a organização do próprio usuário:
aqui nenhuma organização é a ativa. **Não há seletor de organização**: abrir uma na lista
não cria vínculo, não grava cookie e não troca a organização dos módulos operacionais.

## Código reaproveitado

- Autorização: `requirePlatformAdmin` (DAL) em toda página e ação, e `public.is_platform_admin()`
  conferida de novo no banco em cada consulta (`modules/organizations/sql-queries.ts`:
  `listAllOrganizations`, `listEnabledModules`, `getOrganizationModuleConfiguration`,
  `getOrganizationAdminDetails`). Quem não é admin recebe `AccessDeniedError` e é levado a `/visao-geral`.
- Escritas (sem novas): `setOrganizationStatusAction` (`set_organization_status`, 0006) e
  `setOrganizationModuleAction` (`set_organization_module`, 0007). A lista e o detalhe usam o mesmo
  formulário (`admin/_components/organization-status-form.tsx`).
- Painel de módulos: `ModulePanel` (já existia).

## O que o admin da plataforma pode ler (RLS já existente, 0002/0007)

`organizations`, `organization_members`, `profiles`, `whatsapp_accounts`, `organization_modules`.
A central usa colunas explícitas: do canal, só nome, número, tipo e situação (sem identificador
externo nem credenciais).

## O que continua negado (RLS, 0004/0010/0011)

Conversas, mensagens, eventos de atendimento, contatos, fluxos e versões de automações, sessões e
execuções (respostas coletadas) e imagens das automações exigem **vínculo ativo na organização**.
`has_module` e `withOrganizationTransaction` também. A central não os consulta, e
`tests/db/organization-admin.test.ts` prova a negação no banco. A edição de automações pelo suporte
da Antero e qualquer acesso a conteúdo operacional dependem de entregas futuras (G3) com autorização
própria e auditoria.

## Auditoria (G2B)

Suspender, reativar, habilitar e desabilitar módulo geram um evento em `audit_events` na mesma
transação, com o admin da plataforma como autor, só quando o estado muda de fato. Os eventos são
imutáveis e só o admin da plataforma pode lê-los, pelas telas de atividades (G2C, abaixo). Recusas
(acesso de quem não é admin, entrada inválida, organização inexistente, negação no banco) vão para o
log estruturado do servidor. Suspender e reativar respondem com mensagem no próprio formulário, como os
módulos, em vez de levar à página de erro. Detalhes: `docs/DATABASE.md`, "Auditoria administrativa".

## Atividades administrativas (G2C)

Leitura de `audit_events` pela central, sem migration e sem nenhuma permissão nova.

- **Acesso:** card "Atividades administrativas" → "Ver histórico" no detalhe da organização (o detalhe não
  carrega eventos) e link "Atividades administrativas" em `/admin`.
- **O que aparece:** operação em português (Organização suspensa/reativada, Módulo habilitado/desabilitado,
  com o módulo pelo catálogo), estado anterior → posterior, responsável (nome; "Usuário sem nome"; "Usuário
  removido"; ou "Manutenção — alteração direta no banco", sem o papel do banco), tipo de responsável,
  organização (na global; "Organização excluída · 1a2b3c4d" se não existir mais), data e hora de Brasília e
  o número do registro. Mais recentes primeiro. Operações ou responsáveis de tipos que esta versão não
  conhece aparecem de forma genérica ("Operação administrativa"), nunca com o valor cru.
- **Filtros (GET, na URL):** `tipo` (lista fechada), `de` e `ate` (`AAAA-MM-DD`, dias de Brasília, ambos
  inclusivos), `organizacao` (UUID, só na global) e `antes` (cursor). Valor inválido é ignorado; período
  inválido (data inexistente ou inicial depois da final) mostra aviso e só o período é ignorado. Mudar um
  filtro descarta o cursor.
- **Paginação:** 25 por página, keyset `(occurred_at, id)` decrescente, sem OFFSET nem contagem: "Eventos
  mais antigos →" mantém os filtros; "← Voltar aos mais recentes" volta à primeira página. Cursor inválido
  ou adulterado volta aos mais recentes com aviso.
- **Segurança:** `requirePlatformAdmin` na rota; `listAuditEvents` (`modules/audit/sql-queries.ts`) no pool
  `antero_app` com `withUserTransaction`, `is_platform_admin()` conferida no banco e a RLS da 0013 por baixo;
  filtro explícito por organização na rota da organização; id inválido ou inexistente → 404. De `details`
  saem só módulo, de e para. Nenhuma Server Action nem formulário POST nessas telas.
- **Carregamento:** sem `loading.tsx` (ele faria o 404 virar 200): a página autoriza e confere a organização
  e só então a lista entra num `<Suspense>` com esqueleto. Erro de banco cai em `admin/error.tsx`.

## Limites desta entrega

Sem novas permissões, sem criar, editar ou remover vínculos, sem cadastro de organização, sem modo
suporte. (A auditoria chegou na G2B, acima.) Desde a G2A (0012), nem por SQL da aplicação o admin da
plataforma cria vínculos nem cria, exclui ou renomeia organizações: a central só lê, suspende/reativa e
liga módulos pelas funções existentes. Alterações cadastrais futuras serão operações controladas e auditáveis. O vínculo `admin` da conta de teste "Paula Plataforma" na
Clínica Aurora continua sendo um vínculo comum de cliente (ver `claude-reports/2026-11-16-investigacao-admin-global.md`).

## Testes

G2C: unitários (`modules/audit/*.test.ts`, `admin/_lib/format.test.ts`), integração
(`tests/db/audit-history.test.ts`) e E2E (bloco G2C de `tests/e2e/app.test.ts`).

Unitários (`modules/organizations/search.test.ts`), integração (`tests/db/organization-admin.test.ts`:
lista, busca, filtro, recusa de quem não é admin, equipe/canal, isolamento dos dados operacionais, nenhuma
escrita) e E2E (`tests/e2e/app.test.ts`, bloco G1: lista, busca, detalhe, volta, ids manipulados,
usuários comuns, ausência de vínculo/cookie e suspensão pelo detalhe).
