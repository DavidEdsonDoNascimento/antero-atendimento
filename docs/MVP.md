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
- [x] Acesso ao banco e validação de ambiente (Supabase no Ciclo 1; PostgreSQL próprio desde a migração)
- [x] Autenticação: login, logout, recuperação e redefinição de senha
- [x] Organizações e membros (modelo + telas)
- [x] RLS com isolamento multiempresa + funções auxiliares
- [x] Migrations e seed (organização Antero + canal de desenvolvimento)
- [x] Proteção de rotas (proxy + DAL)
- [x] Base do admin da plataforma (`is_platform_admin`)
- [x] `.env.example` e documentação de setup
- [x] Lint, type-check e build passando

Entregue depois do Ciclo 1 (detalhes em `docs/ATENDIMENTO.md`, `docs/AUTOMACOES.md` e
`docs/MODULES.md`):

- Inbox funcional: assumir, responder e resolver conversas, com aviso da janela de 24 h
  (canal de desenvolvimento e simulador de mensagens recebidas; sem WhatsApp real)
- Módulos por organização, habilitados pelo admin da plataforma
- Automações: motor de fluxos e editor self-service em `/fluxos` (criar, editar, testar
  na prévia, publicar, histórico e restauração de versões, imagens); o envio em
  conversas reais do WhatsApp ainda depende de integrações futuras (webhook e Cloud API)

Marcado como “Em breve” na interface (não são botões falsos):

- Contatos e Campanhas: módulos habilitáveis, ainda em desenvolvimento
- Edição de organização e convite de usuários por e-mail (ciclos futuros)

## Telas

- **Visão geral** — organização, papel e indicadores (abertas, aguardando, em
  atendimento, resolvidas) exibidos como placeholders até o Ciclo 2 trazer
  dados reais.
- **Equipe** — lista real de membros (nome, e-mail, papel, status).
- **Configurações** — dados da organização e do canal de WhatsApp (provedor de
  desenvolvimento), somente leitura no Ciclo 1.
- **Conversas** — Inbox com filtros, histórico, assumir, responder e resolver
  (`docs/ATENDIMENTO.md`).
- **Automações** — lista, editor, prévia, publicação e histórico de versões
  (`docs/AUTOMACOES.md`); só owner/admin editam.
- **Admin da plataforma** — lista de organizações, com suspensão, reativação e
  configuração de módulos (apenas `is_platform_admin`). Ver `docs/MODULES.md`.

## Fora do escopo do MVP

Pagamentos/assinaturas, IA generativa, CRM completo, app mobile, microsserviços, construtor visual avançado de fluxos.
Campanhas e Contatos já são módulos habilitáveis, mas ainda sem funcionalidade; Automações tem editor e motor, mas ainda não
responde no WhatsApp real.
Também: não alterar o site institucional, não reutilizar o banco do site, não
colocar tokens no código, não usar dados fixos da Antero nos componentes.

## Roteiro de demonstração (ao final dos primeiros ciclos)

Preparar o ambiente (`docs/SETUP.md`) → criar 1º usuário → cadastrar Antero → login → acessar a
plataforma → (Ciclo 2) criar/ver contato simulado, receber mensagem simulada →
(Ciclo 3) iniciar o fluxo da Antero, responder opções, capturar nome/empresa/
necessidade, encaminhar para humano → assumir como atendente → responder →
resolver. Demonstrável localmente antes do WhatsApp real.
