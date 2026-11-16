# Administração da plataforma (central de organizações, G1)

Área só para quem tem `profiles.is_platform_admin` (equipe da Antero). Serve para
consultar e administrar as organizações clientes. **Não é um modo de suporte**: abrir
uma organização aqui não dá acesso aos dados dela.

## Rotas

| Rota | O que mostra |
| --- | --- |
| `/admin` | Lista de organizações com busca (`?busca=`, nome ou identificador, sem acento nem caixa) e filtro de situação (`?situacao=active\|inactive`); módulos habilitados; suspender e reativar |
| `/admin/organizacoes/[id]` | Dados cadastrais, situação (suspender/reativar), módulos (habilitar/desabilitar), equipe com papéis e situação, canal de atendimento |

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

## Limites desta entrega

Sem migration, sem novas permissões, sem criar, editar ou remover vínculos, sem auditoria, sem
cadastro de organização, sem modo suporte. Desde a G2A (0012), nem por SQL da aplicação o admin da
plataforma cria vínculos nem cria, exclui ou renomeia organizações: a central só lê, suspende/reativa e
liga módulos pelas funções existentes. Alterações cadastrais futuras serão operações controladas e auditáveis. O vínculo `admin` da conta de teste "Paula Plataforma" na
Clínica Aurora continua sendo um vínculo comum de cliente (ver `claude-reports/2026-11-16-investigacao-admin-global.md`).

## Testes

Unitários (`modules/organizations/search.test.ts`), integração (`tests/db/organization-admin.test.ts`:
lista, busca, filtro, recusa de quem não é admin, equipe/canal, isolamento dos dados operacionais, nenhuma
escrita) e E2E (`tests/e2e/app.test.ts`, bloco G1: lista, busca, detalhe, volta, ids manipulados,
usuários comuns, ausência de vínculo/cookie e suspensão pelo detalhe).
