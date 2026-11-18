// Datas do admin da plataforma, sempre no fuso de São Paulo (como a Inbox e
// as Automações): sem `timeZone` explícito, o formatador usaria o fuso do
// servidor, e num servidor em UTC uma organização criada depois das 21h
// (Brasília) apareceria com o dia seguinte.
const TIME_ZONE = "America/Sao_Paulo";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: TIME_ZONE });

/** "9 de mar. de 2026" — data de cadastro na lista de organizações. */
export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** "09/03/2026, 23:59:59" — instante de um evento do histórico de atividades. */
export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}
