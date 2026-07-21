Quero iniciar o desenvolvimento de um novo produto da Antero Sistemas chamado **Antero Atendimento**.

Este repositório acabou de ser criado com Next.js, TypeScript, App Router, Tailwind CSS, ESLint e estrutura dentro de `src`.

## Contexto do produto

O Antero Atendimento será uma plataforma SaaS multiempresa para atendimento inteligente integrado ao WhatsApp.

Não será um chatbot separado para cada cliente e não queremos copiar o código para cada nova empresa.

Será uma única aplicação em que cada empresa terá:

* sua própria organização;
* seus próprios usuários;
* seu próprio número ou conta de WhatsApp;
* seus próprios contatos;
* suas próprias conversas;
* suas próprias mensagens;
* seus próprios atendentes;
* seus próprios fluxos de automação;
* suas próprias configurações.

A primeira empresa que utilizará o sistema será a própria **Antero Sistemas**.

Queremos utilizar a automação no WhatsApp da Antero para atender nossos próprios clientes e demonstrar que usamos a mesma tecnologia que oferecemos.

Depois da validação interna, serão incluídas:

* Invernada do Sol;
* NACIONALTECH Energia Solar.

Mesmo começando somente com a Antero, o sistema deve nascer preparado para múltiplas organizações.

## Filosofia de desenvolvimento

Siga rigorosamente estes princípios:

* MVP primeiro;
* arquitetura preparada para crescer;
* evitar overengineering;
* monólito modular;
* código limpo;
* componentes reutilizáveis;
* TypeScript estrito;
* validação no servidor;
* segurança desde o início;
* interface profissional;
* implementação simples de compreender;
* não criar microsserviços;
* não criar monorepo;
* não criar abstrações sem uso real;
* não instalar bibliotecas sem necessidade;
* não antecipar funcionalidades distantes;
* não implementar recursos que não façam parte do MVP.

Queremos colocar a Antero em produção rapidamente, mas sem construir uma base descartável.

## Stack pretendida

Utilize:

* Next.js com App Router;
* TypeScript;
* Tailwind CSS;
* Supabase para PostgreSQL;
* Supabase Auth;
* Supabase Realtime somente onde trouxer benefício real;
* React Server Components por padrão;
* Client Components apenas quando houver interação que os exija;
* Route Handlers ou Server Actions conforme fizer mais sentido;
* Zod para validação de dados de entrada;
* ESLint;
* npm.

Não adicione Prisma neste momento. Use o cliente oficial do Supabase.

Não instale uma biblioteca grande de gerenciamento de estado. Prefira estado local, Server Components e os recursos nativos do React e Next.js.

Não implemente pagamentos ou assinaturas neste MVP.

## Integração com WhatsApp

A arquitetura deve permitir integração com diferentes provedores de WhatsApp no futuro, mas sem criar um sistema excessivamente genérico.

Crie uma interface simples de provedor com operações essenciais, como:

* enviar mensagem;
* normalizar mensagem recebida;
* identificar conta de WhatsApp;
* validar webhook quando aplicável.

A primeira integração real será feita posteriormente com a API oficial do WhatsApp Cloud API.

Nesta primeira etapa, não invente credenciais e não dependa de uma integração externa para a aplicação funcionar.

Crie um modo de desenvolvimento ou provedor simulado que permita:

* criar contatos;
* iniciar conversas;
* receber mensagens simuladas;
* enviar respostas simuladas;
* validar a interface de atendimento;
* testar o motor de automação.

A integração real deve poder ser adicionada depois sem reescrever os módulos de conversas, contatos e mensagens.

Não implemente ainda um construtor visual complexo de fluxos.

## Escopo funcional do MVP

### 1. Autenticação

Implementar estrutura para:

* login por e-mail e senha;
* logout;
* recuperação de senha;
* proteção das rotas autenticadas;
* vínculo entre usuário e organização;
* identificação da organização ativa.

Inicialmente, um usuário poderá pertencer a uma organização.

Não implemente troca entre várias organizações na interface neste momento, mas modele o banco de maneira que isso seja possível futuramente.

### 2. Organizações

Criar suporte para organizações multiempresa.

A primeira organização será:

* nome: Antero Sistemas;
* slug: antero;
* status: active.

Não inserir credenciais administrativas fixas no código.

Criar uma forma documentada e segura de cadastrar a primeira organização e associar o primeiro usuário a ela.

### 3. Papéis de acesso

Utilizar somente os papéis necessários:

* owner;
* admin;
* attendant.

Permissões iniciais:

* owner: acesso completo à organização;
* admin: configurações, usuários, fluxos e atendimentos;
* attendant: acesso a contatos, conversas e envio de mensagens.

Não criar um sistema complexo de permissões configuráveis.

### 4. Caixa de entrada de conversas

Criar uma área autenticada com:

* lista de conversas;
* nome e telefone do contato;
* última mensagem;
* horário da última interação;
* quantidade de mensagens não lidas;
* status da conversa;
* responsável pelo atendimento;
* busca simples;
* filtros básicos por status;
* seleção de uma conversa;
* histórico de mensagens;
* campo para responder;
* atualização da conversa após uma nova mensagem.

Status iniciais:

* bot;
* waiting;
* human;
* resolved.

Significados:

* `bot`: automação conduzindo o contato;
* `waiting`: aguardando atendimento humano;
* `human`: atendimento assumido por uma pessoa;
* `resolved`: atendimento encerrado.

### 5. Contatos

Criar:

* listagem de contatos;
* visualização de informações básicas;
* nome;
* telefone;
* data do primeiro contato;
* data do último contato;
* observações simples;
* histórico de conversas.

### 6. Mensagens

Modelar:

* mensagens recebidas;
* mensagens enviadas;
* mensagens enviadas pelo robô;
* mensagens enviadas por atendentes;
* status básico de envio;
* identificador externo opcional;
* conteúdo textual;
* data e hora;
* direção da mensagem.

Tipos iniciais:

* inbound;
* outbound.

Origem inicial:

* contact;
* bot;
* user;
* system.

No MVP, concentre-se em mensagens de texto. Não implemente áudio, vídeo, documentos e imagens agora, mas evite uma modelagem que impossibilite adicioná-los futuramente.

### 7. Motor simples de automação

Precisamos de automações com níveis e subníveis, como uma árvore de decisões.

Exemplo inicial da Antero:

Mensagem de abertura:

“Olá! Você entrou em contato com a Antero Sistemas. Para começarmos, como podemos ajudar?”

Opções:

1. Solicitar um orçamento;
2. Conhecer os serviços da Antero;
3. Suporte de um projeto existente;
4. Falar com uma pessoa.

Fluxo de orçamento:

1. Perguntar o nome;
2. Perguntar o nome da empresa;
3. Perguntar brevemente o que a empresa precisa;
4. Perguntar qual é o melhor período para contato;
5. Confirmar que as informações foram recebidas;
6. encaminhar a conversa para atendimento humano.

Fluxo de serviços:

1. Apresentar resumidamente:

   * sistemas sob medida;
   * aplicações web;
   * aplicativos;
   * integrações;
   * automações;
2. perguntar qual serviço despertou interesse;
3. registrar a resposta;
4. oferecer solicitação de orçamento ou atendimento humano.

Fluxo de suporte:

1. perguntar o nome;
2. perguntar qual empresa ou projeto está relacionado;
3. pedir uma descrição breve do problema;
4. encaminhar para atendimento humano.

Fluxo de atendimento humano:

1. informar que a conversa será encaminhada;
2. alterar o status para `waiting`.

O motor deve suportar:

* um fluxo pertencente a uma organização;
* etapas;
* mensagem da etapa;
* tipo da etapa;
* opções;
* próxima etapa;
* captura de resposta;
* encerramento;
* encaminhamento para humano.

Tipos mínimos de etapa:

* message;
* input;
* choice;
* handoff;
* end.

Não faça um editor visual com nós e conexões.

Para o MVP, crie uma tela simples de visualização e configuração básica dos fluxos ou utilize dados iniciais cadastrados por seed, desde que a arquitetura permita uma futura interface administrativa.

Não coloque o fluxo inteiro diretamente dentro de componentes React.

O fluxo deve ser representado em dados persistidos no banco ou em uma estrutura de domínio claramente separada da interface.

### 8. Usuários e equipe

Criar uma página simples para:

* listar usuários da organização;
* mostrar nome;
* e-mail;
* papel;
* status.

No primeiro MVP, não é obrigatório implementar envio completo de convites por e-mail.

Pode ser criada uma forma administrativa documentada de associar usuários à organização.

Não crie usuários falsos automaticamente em produção.

### 9. Configurações

Criar uma área inicial contendo:

* dados da organização;
* informações da conta de WhatsApp;
* estado da integração;
* nome exibido;
* telefone;
* provedor;
* status conectado ou desconectado.

Enquanto não houver integração real, apresentar o provedor de desenvolvimento de forma clara.

### 10. Área administrativa da Antero

Precisamos distinguir:

* usuários clientes das organizações;
* administração interna da plataforma pela Antero.

Crie uma base simples para uma área de administração da plataforma, protegida por uma permissão interna, permitindo futuramente:

* visualizar organizações;
* criar organizações;
* ativar ou desativar organizações;
* visualizar situação das integrações.

Para o primeiro passo, não precisa construir uma administração SaaS completa.

Não confunda o papel `owner` de uma empresa com um administrador global da plataforma.

Utilize um campo ou mecanismo claro como `is_platform_admin`, com acesso verificado no servidor.

## Modelo inicial de dados

Analise e refine, mantendo o MVP simples, as seguintes entidades:

* profiles;
* organizations;
* organization_members;
* whatsapp_accounts;
* contacts;
* conversations;
* messages;
* conversation_assignments;
* flows;
* flow_steps;
* flow_options;
* flow_sessions;
* captured_answers;
* webhook_events.

Todas as tabelas que pertencem a uma empresa devem ter `organization_id`, direta ou indiretamente de maneira segura.

Avalie cuidadosamente quais tabelas realmente precisam de `organization_id` direto para facilitar segurança e consultas.

Campos importantes:

### organizations

* id;
* name;
* slug;
* status;
* created_at;
* updated_at.

### organization_members

* id;
* organization_id;
* user_id;
* role;
* status;
* created_at.

### whatsapp_accounts

* id;
* organization_id;
* provider;
* external_account_id;
* phone_number;
* display_name;
* status;
* created_at;
* updated_at.

### contacts

* id;
* organization_id;
* whatsapp_account_id;
* name;
* phone_number;
* notes;
* first_contact_at;
* last_contact_at;
* created_at;
* updated_at.

### conversations

* id;
* organization_id;
* whatsapp_account_id;
* contact_id;
* status;
* assigned_user_id;
* current_flow_id;
* started_at;
* last_message_at;
* resolved_at;
* created_at;
* updated_at.

### messages

* id;
* organization_id;
* conversation_id;
* external_message_id;
* direction;
* sender_type;
* message_type;
* content;
* delivery_status;
* created_at.

### flows

* id;
* organization_id;
* name;
* description;
* status;
* initial_step_id;
* version;
* created_at;
* updated_at.

### flow_steps

* id;
* organization_id;
* flow_id;
* step_key;
* type;
* message;
* variable_name;
* next_step_id;
* created_at;
* updated_at.

### flow_options

* id;
* organization_id;
* step_id;
* label;
* value;
* next_step_id;
* position.

### flow_sessions

* id;
* organization_id;
* conversation_id;
* flow_id;
* current_step_id;
* status;
* context;
* started_at;
* completed_at;
* updated_at.

### captured_answers

* id;
* organization_id;
* conversation_id;
* flow_session_id;
* step_id;
* variable_name;
* value;
* created_at.

Use UUIDs.

Use enums PostgreSQL apenas quando trouxerem clareza e não dificultarem alterações comuns do MVP.

Crie índices para as consultas principais, sem adicionar índices especulativos.

Considere idempotência para futuras mensagens recebidas pelo webhook por meio de identificadores externos únicos.

## Segurança

A separação entre organizações é uma exigência obrigatória.

Implementar Row Level Security no Supabase.

As políticas devem impedir que:

* um usuário da Antero veja dados de outra organização;
* um usuário da Invernada veja dados da NACIONALTECH;
* um atendente altere configurações administrativas;
* um usuário não autenticado acesse dados internos;
* o cliente envie um `organization_id` diferente e acesse outra empresa.

Não confie apenas em filtros no frontend.

Não utilize o `service_role` no navegador.

Segredos devem existir somente no servidor.

Criar:

* `.env.example`;
* documentação das variáveis;
* validação das variáveis de ambiente;
* cliente Supabase para navegador;
* cliente Supabase para servidor;
* tratamento seguro de sessão;
* proteção das rotas.

Não grave conteúdo sensível em logs desnecessariamente.

Não exponha telefone, mensagens ou tokens em logs de produção.

## Interface

A interface deve seguir uma identidade profissional, premium e objetiva da Antero.

Direção visual:

* fundo predominantemente escuro;
* preto e tons de cinza;
* detalhes discretos dourados;
* excelente contraste;
* visual corporativo;
* navegação simples;
* sem excesso de gradientes;
* sem aparência genérica de template;
* sem animações desnecessárias;
* responsiva;
* acessível.

O material de identidade visual já existente da Antero pode servir somente como referência de marca.

Estrutura da plataforma:

* barra lateral;
* cabeçalho;
* conteúdo principal;
* identificação da organização ativa;
* menu do usuário.

Itens iniciais da navegação:

* Visão geral;
* Conversas;
* Contatos;
* Fluxos;
* Equipe;
* Configurações.

A tela mais importante é Conversas. Priorize sua usabilidade.

Não gaste tempo criando um dashboard cheio de gráficos sem dados reais.

Na visão geral, apresente apenas indicadores úteis:

* conversas abertas;
* aguardando atendimento;
* em atendimento humano;
* resolvidas recentemente.

## Estrutura sugerida

Organize por módulos de negócio, evitando uma pasta genérica gigantesca.

Uma referência possível:

src/
app/
(auth)/
(platform)/
admin/
api/
components/
ui/
layout/
modules/
auth/
organizations/
users/
whatsapp/
contacts/
conversations/
messages/
flows/
lib/
supabase/
env/
validation/
types/

Você pode ajustar essa estrutura caso exista uma alternativa mais adequada, mas explique a decisão.

Não crie camadas como repository, service, manager, handler e controller para toda entidade sem necessidade.

## Qualidade

Antes de considerar uma etapa concluída:

* executar ESLint;
* executar TypeScript;
* executar build;
* corrigir erros;
* verificar imports;
* remover código morto;
* garantir estados de loading, vazio e erro;
* validar o comportamento responsivo básico;
* não deixar botões que fingem funcionar;
* marcar claramente funcionalidades ainda não implementadas;
* documentar decisões importantes.

Crie scripts separados no `package.json`, se necessário, para:

* lint;
* typecheck;
* build.

## Forma de trabalho

Primeiro:

1. analise todo o repositório;
2. leia `AGENTS.md`, `CLAUDE.md` e demais instruções existentes;
3. informe resumidamente o estado atual;
4. proponha um plano incremental;
5. identifique decisões realmente bloqueantes;
6. não crie dezenas de documentos de planejamento.

Crie no máximo:

* `docs/ARCHITECTURE.md`;
* `docs/DATABASE.md`;
* `docs/SETUP.md`;
* `docs/MVP.md`.

Use esses documentos apenas se forem úteis e mantenha-os objetivos.

Depois da análise, comece a implementação do primeiro ciclo sem esperar uma nova autorização, desde que nenhuma decisão realmente bloqueante impeça o trabalho.

## Ordem de implementação

### Ciclo 1 — Fundação

Implementar:

* estrutura modular;
* identidade visual inicial;
* layout autenticado;
* configuração do Supabase;
* autenticação;
* organizações;
* membros;
* RLS;
* migrations;
* seed ou processo seguro para cadastrar a Antero;
* proteção de rotas;
* `.env.example`;
* documentação de setup.

### Ciclo 2 — Atendimento simulado

Implementar:

* contatos;
* conversas;
* mensagens;
* caixa de entrada;
* envio de mensagens simuladas;
* recebimento de mensagens simuladas;
* provedor de desenvolvimento;
* estados das conversas;
* atribuição de atendente.

### Ciclo 3 — Automação

Implementar:

* tabelas de fluxo;
* fluxo inicial da Antero;
* sessões de execução;
* níveis e subníveis;
* captura de respostas;
* encaminhamento para humano;
* histórico completo no painel.

### Ciclo 4 — Preparação para WhatsApp real

Implementar apenas a base necessária:

* contrato do provedor;
* endpoint de webhook;
* verificação de assinatura preparada;
* idempotência;
* normalização de mensagens;
* documentação das variáveis necessárias.

Não implemente comportamentos inventados da API externa. Quando chegar à integração real, consulte a documentação oficial correspondente.

## Entregável inicial esperado

Quero que ao final dos primeiros ciclos seja possível:

1. configurar o Supabase;
2. criar o primeiro usuário;
3. cadastrar a organização Antero;
4. fazer login;
5. acessar a plataforma;
6. criar ou visualizar um contato simulado;
7. receber uma mensagem simulada;
8. iniciar automaticamente o fluxo da Antero;
9. responder às opções;
10. avançar entre níveis e subníveis;
11. capturar nome, empresa e necessidade;
12. encaminhar para atendimento humano;
13. assumir a conversa como atendente;
14. responder manualmente;
15. resolver a conversa.

O funcionamento deve ser demonstrável localmente mesmo antes da integração real com o WhatsApp.

## Restrições finais

Não:

* altere o site institucional da Antero;
* reutilize o banco do site;
* crie integrações falsas;
* coloque tokens no código;
* deixe o isolamento multiempresa para depois;
* use dados fixos da Antero nos componentes;
* construa funcionalidades de Invernada do Sol ou NACIONALTECH agora;
* crie dashboards complexos;
* implemente cobrança;
* implemente IA generativa;
* implemente CRM completo;
* implemente campanhas ou disparos em massa;
* implemente aplicativo mobile;
* implemente microsserviços;
* implemente construtor visual avançado de fluxos.

A Antero deve ser cadastrada como uma organização comum da plataforma, e não tratada como exceção no código.

Comece analisando o repositório e depois execute o Ciclo 1. Ao finalizar, apresente:

* arquivos criados e modificados;
* decisões técnicas;
* migrations criadas;
* variáveis de ambiente necessárias;
* comandos que preciso executar;
* como testar;
* itens concluídos;
* próximos passos;
* qualquer hipótese utilizada.
