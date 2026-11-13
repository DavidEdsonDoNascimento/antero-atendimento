import type { FlowDefinitionInput } from "../automations/definition";

/**
 * Fluxo DEMONSTRATIVO de um espaço de eventos e gastronomia fictício ("Recanto
 * Exemplo"): boas-vindas com imagem, menu principal, reservas, eventos,
 * fornecedores, informações, falar com atendente, coleta de dados e
 * encaminhamento. Cobre o roteiro de um piloto real sem nenhum dado dele.
 *
 * Só desenvolvimento e testes: este arquivo fica no módulo do simulador, fora
 * da imagem de produção (.dockerignore) e de qualquer rota do `next build`.
 * Nenhuma organização o recebe automaticamente — só pela ação do simulador ou
 * pelos testes.
 */
export const DEMO_FLOW_SLUG = "atendimento-demo";
export const DEMO_FLOW_NAME = "Atendimento de entrada (demonstração)";

const reservationQuestions = (prefix: string, experience: string) => [
  {
    type: "question" as const,
    id: `${prefix}-nome`,
    text: `Ótimo! Para pré-reservar o ${experience}, qual é o seu nome?`,
    variable: "nome",
    label: "Nome",
    next: `${prefix}-pessoas`,
  },
  {
    type: "question" as const,
    id: `${prefix}-pessoas`,
    text: "Para quantas pessoas?",
    variable: "pessoas",
    label: "Pessoas",
    maxLength: 40,
    next: "reserva-aviso",
  },
];

export const DEMO_FLOW_DEFINITION = {
  schemaVersion: 1,
  entryStepId: "boas-vindas",
  mainMenuStepId: "menu-principal",
  settings: {
    handoffMessage: "Certo! Já passei sua conversa para a nossa equipe. Em breve alguém responde por aqui. 🙂",
    handoffUnavailableMessage: "No momento não temos atendimento humano por aqui. Você pode voltar ao menu a qualquer hora.",
  },
  steps: [
    {
      type: "image",
      id: "boas-vindas",
      url: "https://exemplo.invalid/programacao-da-semana.jpg",
      caption: "Olá! Bem-vindo ao Recanto Exemplo. 🌿 Esta é a nossa programação da semana.",
      next: "menu-principal",
    },
    {
      type: "menu",
      id: "menu-principal",
      header: "Recanto Exemplo",
      text: "Como podemos ajudar? Escolha uma opção.",
      button: "Ver opções",
      options: [
        { id: "reservas", title: "Reservas", description: "Pré-reserve, altere ou cancele", next: "menu-reservas" },
        { id: "eventos", title: "Eventos particulares", description: "Aniversários, casamentos e confraternizações", next: "eventos-intro" },
        { id: "fornecedor", title: "Sou fornecedor", description: "Apresente sua empresa", next: "fornecedor-descricao" },
        { id: "informacoes", title: "Informações", description: "Localização, pagamento e mais", next: "menu-informacoes" },
        { id: "atendente", title: "Falar com atendente", next: "encaminhar" },
      ],
    },
    {
      type: "menu",
      id: "menu-reservas",
      text: "Qual experiência você quer reservar?",
      options: [
        { id: "cafe", title: "Café da tarde", description: "Sábados, das 15h às 18h", next: "cafe-info" },
        { id: "jantar", title: "Jantar temático", description: "Sextas, a partir das 19h", next: "jantar-info" },
        { id: "almoco", title: "Almoço de domingo", description: "Domingos, das 12h às 15h", next: "almoco-info" },
        { id: "alterar", title: "Alterar uma reserva", next: "alterar-nome" },
        { id: "cancelar", title: "Cancelar uma reserva", next: "cancelar-nome" },
      ],
      showBack: true,
      showMainMenu: true,
    },
    { type: "message", id: "cafe-info", text: "Café da tarde: buffet completo, R$ 00,00 por pessoa (valor de exemplo).", next: "cafe-nome" },
    ...reservationQuestions("cafe", "café da tarde"),
    { type: "message", id: "jantar-info", text: "Jantar temático: entrada, prato principal e sobremesa (valor de exemplo).", next: "jantar-nome" },
    ...reservationQuestions("jantar", "jantar temático"),
    { type: "message", id: "almoco-info", text: "Almoço de domingo: cardápio do dia (valor de exemplo).", next: "almoco-nome" },
    ...reservationQuestions("almoco", "almoço de domingo"),
    {
      type: "message",
      id: "reserva-aviso",
      text: "Anotado! Atenção: a reserva só vale depois da confirmação da nossa equipe.",
      next: "encaminhar",
    },
    {
      type: "question",
      id: "alterar-nome",
      text: "Em qual nome está a reserva?",
      variable: "nome",
      label: "Nome",
      next: "alterar-detalhe",
    },
    {
      type: "question",
      id: "alterar-detalhe",
      text: "Qual experiência e o que você quer alterar?",
      variable: "alteracao",
      label: "Alteração pedida",
      next: "encaminhar",
    },
    {
      type: "question",
      id: "cancelar-nome",
      text: "Em qual nome está a reserva?",
      variable: "nome",
      label: "Nome",
      next: "cancelar-evento",
    },
    {
      type: "question",
      id: "cancelar-evento",
      text: "Qual experiência você quer cancelar?",
      variable: "cancelamento",
      label: "Cancelamento de",
      next: "encaminhar",
    },
    {
      type: "message",
      id: "eventos-intro",
      text: "Organizamos eventos particulares para até 120 pessoas (exemplo). Vou anotar alguns dados.",
      next: "eventos-nome",
    },
    { type: "question", id: "eventos-nome", text: "Qual é o seu nome?", variable: "nome", label: "Nome", next: "eventos-convidados" },
    {
      type: "question",
      id: "eventos-convidados",
      text: "Quantos convidados, aproximadamente?",
      variable: "convidados",
      label: "Convidados",
      maxLength: 40,
      next: "eventos-data",
    },
    {
      type: "question",
      id: "eventos-data",
      text: "Qual a data desejada?",
      variable: "data",
      label: "Data desejada",
      maxLength: 60,
      next: "eventos-fim",
    },
    {
      type: "handoff",
      id: "eventos-fim",
      text: "Obrigado! Nossa equipe de eventos vai preparar uma proposta e responder por aqui.",
    },
    {
      type: "question",
      id: "fornecedor-descricao",
      text: "Conte brevemente o que sua empresa oferece.",
      variable: "oferta",
      label: "Oferta",
      next: "fornecedor-empresa",
    },
    {
      type: "question",
      id: "fornecedor-empresa",
      text: "Qual é o nome da empresa?",
      variable: "empresa",
      label: "Empresa",
      next: "fornecedor-telefone",
    },
    {
      type: "question",
      id: "fornecedor-telefone",
      text: "Qual telefone para contato?",
      variable: "telefone",
      label: "Telefone",
      maxLength: 40,
      next: "encaminhar",
    },
    {
      type: "menu",
      id: "menu-informacoes",
      text: "Sobre o que você quer saber?",
      options: [
        { id: "localizacao", title: "Localização", next: "info-localizacao" },
        { id: "pagamento", title: "Formas de pagamento", next: "info-pagamento" },
        { id: "redes", title: "Redes sociais", next: "info-redes" },
        { id: "pets", title: "Aceitam pets?", next: "info-pets" },
      ],
      showBack: true,
      showMainMenu: true,
    },
    { type: "message", id: "info-localizacao", text: "Estrada Exemplo, km 0 — Cidade Exemplo (endereço fictício).", next: "menu-informacoes" },
    { type: "message", id: "info-pagamento", text: "Aceitamos Pix, cartões e dinheiro (exemplo).", next: "menu-informacoes" },
    { type: "message", id: "info-redes", text: "Siga @recanto.exemplo (perfil fictício).", next: "menu-informacoes" },
    { type: "message", id: "info-pets", text: "Pets são bem-vindos nas áreas externas (política de exemplo).", next: "menu-informacoes" },
    {
      type: "handoff",
      id: "encaminhar",
      unavailableNext: "menu-principal",
    },
  ],
} satisfies FlowDefinitionInput;
