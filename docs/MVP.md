# MVP — Antero Atendimento

Plataforma SaaS multiempresa de atendimento inteligente integrado ao WhatsApp.
Uma única aplicação; cada empresa é uma **organização** isolada. A primeira
organização é a própria **Antero Sistemas**.

## Princípios

MVP primeiro · arquitetura preparada para crescer · sem overengineering ·
monólito modular · validação no servidor · segurança e isolamento multiempresa
desde o início.

## Ciclos

- **Ciclo 1 — Fundação** ✅ (este entregável)
- **Ciclo 2 — Atendimento simulado** ⏳ contatos, conversas, mensagens, caixa
  de entrada, provedor de desenvolvimento, atribuição de atendente.
- **Ciclo 3 — Automação** ⏳ fluxos com níveis/subníveis, sessões, captura de
  respostas, encaminhamento para humano.
- **Ciclo 4 — Preparação p/ WhatsApp real** ⏳ contrato de provedor, webhook,
  verificação de assinatura, idempotência, normalização.

## Status do Ciclo 1

Concluído:

- [x] Estrutura modular por domínio
- [x] Identidade visual inicial (escuro premium + dourado discreto)
- [x] Layout autenticado (sidebar, header, org ativa, menu do usuário)
- [x] Clients Supabase (browser e server) + validação de env com Zod
- [x] Autenticação: login, logout, recuperação e redefinição de senha
- [x] Organizações e membros (modelo + telas)
- [x] RLS com isolamento multiempresa + funções auxiliares
- [x] Migrations e seed (organização Antero + canal de desenvolvimento)
- [x] Proteção de rotas (proxy + DAL)
- [x] Base do admin da plataforma (`is_platform_admin`)
- [x] `.env.example` e documentação de setup
- [x] Lint, type-check e build passando

Marcado como “Em breve” na interface (não são botões falsos):

- Conversas, Contatos (Ciclo 2) · Fluxos (Ciclo 3)
- Edição de organização e convite de usuários por e-mail (ciclos futuros)

## Telas

- **Visão geral** — organização, papel e indicadores (abertas, aguardando, em
  atendimento, resolvidas) exibidos como placeholders até o Ciclo 2 trazer
  dados reais.
- **Equipe** — lista real de membros (nome, e-mail, papel, status).
- **Configurações** — dados da organização e do canal de WhatsApp (provedor de
  desenvolvimento), somente leitura no Ciclo 1.
- **Admin da plataforma** — lista de organizações (apenas `is_platform_admin`).

## Fora do escopo do MVP

Pagamentos/assinaturas, IA generativa, CRM completo, campanhas/disparos em
massa, app mobile, microsserviços, construtor visual avançado de fluxos.
Também: não alterar o site institucional, não reutilizar o banco do site, não
colocar tokens no código, não usar dados fixos da Antero nos componentes.

## Roteiro de demonstração (ao final dos primeiros ciclos)

Configurar Supabase → criar 1º usuário → cadastrar Antero → login → acessar a
plataforma → (Ciclo 2) criar/ver contato simulado, receber mensagem simulada →
(Ciclo 3) iniciar o fluxo da Antero, responder opções, capturar nome/empresa/
necessidade, encaminhar para humano → assumir como atendente → responder →
resolver. Demonstrável localmente antes do WhatsApp real.
