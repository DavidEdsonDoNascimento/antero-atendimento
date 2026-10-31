# Módulos por organização

O Antero Atendimento é vendido por módulo. Cada organização tem a própria
configuração, gravada no banco e alterada pelo administrador da plataforma, sem
código, migration ou deploy por cliente. É proibido criar regra com nome, id ou
identificador de cliente: toda diferença entre organizações é uma linha em
`organization_modules`.

| Identificador | Nome | Finalidade | Rotas | Situação |
| --- | --- | --- | --- | --- |
| `atendimento` | Atendimento | Inbox e atendimento humano | `/conversas` | disponível (leitura) |
| `automacoes` | Automações | Fluxos, menus e respostas automáticas | `/fluxos` | em desenvolvimento |
| `campanhas` | Campanhas | Criação e envio de campanhas | `/campanhas` | em desenvolvimento |
| `contatos` | Contatos | Gestão, importação e listas comerciais | `/contatos` | em desenvolvimento |

Visão geral, Equipe e Configurações são núcleo: existem para toda organização
ativa. Nenhum módulo habilita envio ou automação real ainda; as páginas dos
módulos em desenvolvimento só informam isso.

## Como uma organização recebe módulos

- **Organização nova:** nasce sem nenhum módulo. Sem linha significa desabilitado.
- **Organizações anteriores à migration `0007`:** receberam Atendimento, porque já
  usavam a Inbox. Nada mais foi habilitado.
- **Configuração:** `/admin` → "Configurar módulos" → Habilitar ou Desabilitar.
  Cada alteração muda um único módulo e registra responsável e horário.

Só `is_platform_admin` altera. Owner, admin e atendente não têm caminho nenhum: o
papel é conferido na Server Action e em `public.set_organization_module`, e
`antero_app` não tem INSERT, UPDATE nem DELETE na tabela.

## Como o servidor valida

| Camada | O que faz |
| --- | --- |
| Menu (`nav-config.tsx`, `filterByModules`) | Só esconde. Não protege nada |
| Página ou ação (`requireModule`) | Lê os módulos da organização ativa e leva a `/modulo-indisponivel` |
| Transação (`withModuleTransaction`) | Confere `public.has_module` na transação dos dados; nega com `ModuleDisabledError` |
| RLS das tabelas novas | `is_org_member(organization_id) AND has_module(organization_id, '<módulo>')` |

`has_module(org, módulo)` responde pelo usuário da transação: exige vínculo ativo,
organização ativa e módulo habilitado. Informar o id de outra organização devolve
`false`. O admin da plataforma não é membro implícito: configura, mas não opera
nem lê dados da organização.

Desligar vale na requisição seguinte, porque nada é guardado entre requisições. O
layout não roda de novo na navegação pelo cliente, então uma aba já aberta pode
mostrar um item antigo no menu até recarregar. Clicar nele é negado no servidor, e
a tela de indisponível atualiza o menu da aba. Um módulo recém-habilitado aparece
no próximo carregamento completo.

## Dependências

Campanhas depende de Contatos, por causa de públicos, listas e consentimento.

- Não é possível habilitar Campanhas sem Contatos.
- Não é possível desabilitar Contatos com Campanhas habilitado: desabilite
  Campanhas antes. São duas ações explícitas, não há desligamento em cascata.
- O painel explica o bloqueio, mas a decisão é de `set_organization_module`, que
  trava a linha da organização para que alterações simultâneas não quebrem a regra.

Automações e Atendimento são independentes: um cliente pode contratar só
Automações. O encaminhamento para humano tratará esse destino quando existir.

## Organização suspensa

A suspensão vem antes dos módulos: `is_org_member` falha, então `has_module` também,
e o usuário vai para `/organizacao-suspensa`. O admin da plataforma continua vendo
e ajustando a configuração. Reativar restaura a configuração como está gravada.

## Dados preservados

Desabilitar um módulo não apaga nada. `contacts`, `conversations` e `messages` são
núcleo compartilhado e continuam recebendo dados: `ingest_inbound_message` não
consulta módulos, para uma organização só com Automações poder gravar conversas.
Por isso essas tabelas não têm `has_module` nas políticas, o que também evita custo
por linha nas tabelas grandes; a guarda da Inbox é `withModuleTransaction`.

## Como adicionar um módulo

1. Migration **separada** com `alter type public.organization_module add value '<id>'`
   (o valor novo não pode ser usado na mesma transação).
2. Se houver dependência, migration que ajuste `set_organization_module`.
3. Adicione o tipo em `lib/types/database.ts` e a entrada em `ORGANIZATION_MODULES` e
   `MODULE_CATALOG` (`modules/organizations/modules.ts`), com `requires` igual ao SQL.
4. Item em `mainNav` com `module`.

## Como proteger rotas e ações de um módulo

```ts
// Página: a primeira linha, em TODAS as páginas da rota.
const context = await requireModule("campanhas");

// Server Action: papel e módulo aqui, e de novo na transação.
export async function pausarCampanhaAction(formData: FormData) {
  const context = await requireModule("campanhas");
  await withModuleTransaction(organizationContextOf(context), "campanhas", async (tx) => {
    // ...
  });
}
```

Tabela nova de um módulo: `organization_id`, RLS com a política da tabela acima e
pgTAP. O worker, quando existir, confere o módulo antes de processar. Registre a rota
em `routes` do catálogo: `modules.test.ts` exige `requireModule` em todas as páginas
dela, e nunca use a organização ou o módulo enviados pelo navegador.
