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
