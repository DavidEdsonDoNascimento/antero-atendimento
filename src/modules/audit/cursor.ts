import { z } from "zod";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { InvalidAuditCursorError } from "./errors.ts";

// Lógica pura (JSON + base64url + validação Zod, sem I/O), no formato dos
// cursores da Inbox (`modules/conversations/cursor.ts`): o par completo da
// ordenação, `(occurred_at, id)`. O id do evento é `bigint`; trafega como
// texto decimal e é recusado aqui se não couber no `bigint` do PostgreSQL.
// Nenhum dado além do instante e do id do evento entra no cursor.

export type AuditEventCursor = {
  occurredAt: string;
  id: string;
};

const BIGINT_MAX = BigInt("9223372036854775807");

const auditEventCursorSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }),
  id: z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= BIGINT_MAX),
});

export function encodeAuditEventCursor(cursor: AuditEventCursor): string {
  return Buffer.from(JSON.stringify({ occurredAt: cursor.occurredAt, id: cursor.id }), "utf8").toString("base64url");
}

/** @throws {InvalidAuditCursorError} quando `raw` não é um cursor de auditoria válido. */
export function decodeAuditEventCursor(raw: string): AuditEventCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidAuditCursorError();
  }
  const result = auditEventCursorSchema.safeParse(parsed);
  if (!result.success) throw new InvalidAuditCursorError();
  return result.data;
}
