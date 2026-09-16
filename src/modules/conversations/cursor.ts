import { z } from "zod";

// Extensão .ts explícita: importação de VALOR (classe usada em runtime, não
// só tipo) — o ESM nativo do Node exige extensão explícita para resolver
// especificadores relativos; sem isso `node --test` falha ao carregar este
// módulo. `allowImportingTsExtensions` (tsconfig.json) permite isso sem
// quebrar o build do Next.js, que resolve por bundler e ignora a extensão.
import { InvalidCursorError } from "./errors.ts";

// Lógica pura (JSON + base64 + validação Zod, sem I/O, sem segredo) — sem
// `import "server-only"` de propósito, para permanecer testável com
// `node --test` sem flags especiais. O limite server-side real está em
// `queries.ts`, que é quem toca o cliente Supabase/cookies e importa este
// módulo.

/**
 * Cursores de paginação por keyset (nunca OFFSET) para as duas listas desta
 * DAL. Cada cursor carrega o par completo usado na ordenação, incluindo o
 * UUID de desempate — nunca confiamos só no timestamp, que pode empatar.
 *
 * Formato de serialização (quando trafegado como string, por exemplo em um
 * `searchParams` futuro): JSON `{ campo, id }` codificado em base64url. O
 * cursor é opaco para o chamador — não deve ser inspecionado nem montado
 * manualmente fora deste módulo. Nenhum dado sensível (conteúdo de
 * mensagem, telefone) entra no cursor: apenas timestamp + UUID.
 */

export type ConversationCursor = {
  lastMessageAt: string;
  id: string;
};

export type MessageHistoryCursor = {
  createdAt: string;
  id: string;
};

const conversationCursorSchema = z.object({
  lastMessageAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

const messageHistoryCursorSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidCursorError();
  }
  return result.data;
}

export function encodeConversationCursor(cursor: ConversationCursor): string {
  return encodeCursor(cursor);
}

/** @throws {InvalidCursorError} quando `raw` não é um cursor de conversa válido. */
export function decodeConversationCursor(raw: string): ConversationCursor {
  return decodeCursor(raw, conversationCursorSchema);
}

export function encodeMessageHistoryCursor(cursor: MessageHistoryCursor): string {
  return encodeCursor(cursor);
}

/** @throws {InvalidCursorError} quando `raw` não é um cursor de histórico válido. */
export function decodeMessageHistoryCursor(raw: string): MessageHistoryCursor {
  return decodeCursor(raw, messageHistoryCursorSchema);
}
