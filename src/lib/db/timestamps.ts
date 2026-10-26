/**
 * Timestamps do PostgreSQL como STRING ISO 8601, sem perder microssegundos.
 *
 * Por padrão o `pg` converte `timestamptz`/`timestamp` em `Date`, que só
 * guarda milissegundos: dois `created_at` diferentes apenas nos
 * microssegundos virariam o mesmo instante, e um cursor de paginação
 * montado a partir deles pularia ou repetiria linhas. O pool da aplicação
 * (pool.ts) troca esses parsers, SÓ para as próprias conexões, por estas
 * funções.
 *
 * Formato produzido = o mesmo que o PostgreSQL gera em JSON (`to_json`) e que
 * o PostgREST devolvia para a DAL atual: `2026-10-26T13:45:12.123456+00:00`
 * (fração sem zeros à direita, como o PostgreSQL a escreve). Assim os tipos
 * `string` de `modules/conversations/rows.ts` e os cursores existentes
 * (`z.iso.datetime({ offset: true })`) continuam válidos.
 *
 * Entrada esperada: saída textual com `DateStyle = ISO` (fixado pelo pool).
 * Valores especiais (`infinity`, datas BC) ou um DateStyle diferente são
 * devolvidos como o PostgreSQL os escreveu — nunca convertidos de forma
 * aproximada; um cursor com esse valor é rejeitado pela validação da DAL.
 *
 * Lógica pura — sem `import "server-only"`, testável com `node --test`.
 */

const TIMESTAMPTZ_TEXT =
  /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-]\d{2})(?::(\d{2}))?(?::(\d{2}))?$/;

const TIMESTAMP_TEXT = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;

/** `2026-10-26 13:45:12.123456+00` → `2026-10-26T13:45:12.123456+00:00`. */
export function pgTimestamptzToIso(value: string): string {
  const match = TIMESTAMPTZ_TEXT.exec(value);
  if (!match) return value;
  const [, date, time, offsetHours, offsetMinutes = "00", offsetSeconds] = match;
  return `${date}T${time}${offsetHours}:${offsetMinutes}${offsetSeconds ? `:${offsetSeconds}` : ""}`;
}

/** `2026-10-26 13:45:12.123456` → `2026-10-26T13:45:12.123456` (sem fuso). */
export function pgTimestampToIso(value: string): string {
  const match = TIMESTAMP_TEXT.exec(value);
  return match ? `${match[1]}T${match[2]}` : value;
}
