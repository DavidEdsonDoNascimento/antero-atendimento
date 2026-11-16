// Datas da área de automações, no fuso de São Paulo (como a Inbox).
const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "dd/mm/aaaa, HH:mm". */
export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}
