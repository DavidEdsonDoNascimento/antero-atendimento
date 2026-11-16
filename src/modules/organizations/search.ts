// Filtros da lista de organizações do admin da plataforma, puros (sem I/O),
// para serem testáveis com `node --test`. Valores vindos da URL nunca chegam
// ao SQL sem passar por aqui: o termo vira um padrão LIKE escapado e o status
// só aceita os dois valores do enum.
import type { OrganizationStatus } from "../../lib/types/database";

export const ORGANIZATION_SEARCH_MAX_LENGTH = 80;

/** Letras acentuadas que a busca ignora (maiúsculas e minúsculas). Mesmo mapa no SQL (`translate`). */
export const FOLD_FROM = "áàâãäÁÀÂÃÄéèêëÉÈÊËíìîïÍÌÎÏóòôõöÓÒÔÕÖúùûüÚÙÛÜçÇ";
export const FOLD_TO = "a".repeat(10) + "e".repeat(8) + "i".repeat(8) + "o".repeat(10) + "u".repeat(8) + "c".repeat(2);

const FOLD_MAP = new Map([...FOLD_FROM].map((char, index) => [char, FOLD_TO[index]]));

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Texto sem acentos e em minúsculas, como o SQL compara. */
export function foldSearchText(text: string): string {
  return [...text].map((char) => FOLD_MAP.get(char) ?? char).join("").toLowerCase();
}

/** Termo digitado: aparado, sem excesso de espaços e com tamanho limitado. Vazio vira `undefined`. */
export function parseOrganizationSearch(raw: string | string[] | undefined): string | undefined {
  const value = firstValue(raw)?.replace(/\s+/g, " ").trim().slice(0, ORGANIZATION_SEARCH_MAX_LENGTH);
  return value ? value : undefined;
}

export function parseOrganizationStatusFilter(raw: string | string[] | undefined): OrganizationStatus | undefined {
  const value = firstValue(raw);
  return value === "active" || value === "inactive" ? value : undefined;
}

/** Padrão LIKE (com `\` como escape) que acha o termo em qualquer parte do nome ou do identificador. */
export function organizationSearchPattern(term: string): string {
  return `%${foldSearchText(term).replace(/[\\%_]/g, "\\$&")}%`;
}

/** Endereço da lista com os filtros ativos (só o que difere do padrão). */
export function organizationsHref(filters: { search?: string; status?: OrganizationStatus } = {}): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("busca", filters.search);
  if (filters.status) params.set("situacao", filters.status);
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}
