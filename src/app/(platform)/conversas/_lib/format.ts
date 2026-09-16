/**
 * Formatação de datas da caixa de conversas — sempre no fuso de São Paulo
 * (produto brasileiro; o Brasil não usa horário de verão desde 2019, então
 * subtrair 24h em UTC equivale exatamente a "o mesmo horário ontem" neste
 * fuso, sem precisar de uma biblioteca de fuso horário).
 *
 * Vive na rota (não em `modules/conversations/`) de propósito: é
 * apresentação, e a DAL documenta explicitamente que não tem dependência de
 * UI.
 */

const TIME_ZONE = "America/Sao_Paulo";

const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

// `en-CA` produz "aaaa-mm-dd" — usado só como chave de comparação de dia,
// nunca exibido.
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dayKey(date: Date): string {
  return dayKeyFormatter.format(date);
}

/** "HH:mm" no fuso de São Paulo — horário de cada mensagem no histórico. */
export function formatMessageTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/**
 * Horário da última atividade de uma conversa: "HH:mm" se for hoje,
 * "Ontem" se for o dia anterior, ou "dd/mm/aaaa" caso contrário — todos
 * calculados no fuso de São Paulo.
 */
export function formatLastActivity(iso: string, now: Date = new Date()): string {
  const target = new Date(iso);
  const targetKey = dayKey(target);

  if (targetKey === dayKey(now)) {
    return timeFormatter.format(target);
  }

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (targetKey === dayKey(yesterday)) {
    return "Ontem";
  }

  return dateFormatter.format(target);
}
