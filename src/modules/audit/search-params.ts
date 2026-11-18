// Filtros do histórico de atividades administrativas, puros (sem I/O), no
// padrão de `modules/organizations/search.ts`: nenhum valor da URL chega ao
// SQL sem passar por aqui. Tipo só da lista fechada; datas só `AAAA-MM-DD`
// reais; organização só UUID; o cursor continua opaco (quem o valida é
// `cursor.ts`, na leitura).
import { z } from "zod";

import type { AuditAction } from "../../lib/types/database";
// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { isAuditAction } from "./catalog.ts";

/** Valores crus de `searchParams` aceitos pelas páginas de atividades. */
export type ActivitySearchParams = {
  tipo?: string | string[];
  de?: string | string[];
  ate?: string | string[];
  organizacao?: string | string[];
  antes?: string | string[];
};

/** Filtros efetivos: só o que passou na validação. */
export type ActivityFilters = {
  action?: AuditAction;
  /** Primeiro dia (inclusive), calendário de Brasília. */
  from?: string;
  /** Último dia (inclusive), calendário de Brasília. */
  to?: string;
  organizationId?: string;
};

export type ParsedActivitySearch = {
  filters: ActivityFilters;
  cursor?: string;
  /** Período informado e recusado (data inválida ou inicial depois da final): aviso na tela, período ignorado. */
  periodInvalid: boolean;
  /** Datas bem formadas para reexibir no formulário, mesmo quando o período foi recusado. */
  periodInput: { from?: string; to?: string };
};

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const uuidSchema = z.uuid();

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parseAuditActionFilter(raw: string | string[] | undefined): AuditAction | undefined {
  const value = firstValue(raw);
  return value && isAuditAction(value) ? value : undefined;
}

/**
 * Dia do calendário `AAAA-MM-DD` que existe de fato (rejeita 2026-02-30) e
 * dentro de 2000–2100. Ausente ou vazio → `undefined`; inválido → `null`.
 */
export function parseCalendarDate(raw: string | string[] | undefined): string | undefined | null {
  const value = firstValue(raw)?.trim();
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

/** UUID da organização do filtro global; qualquer outra coisa não filtra. */
export function parseOrganizationFilter(raw: string | string[] | undefined): string | undefined {
  const value = firstValue(raw);
  return value && uuidSchema.safeParse(value).success ? value.toLowerCase() : undefined;
}

export function parseActivitySearchParams(
  sp: ActivitySearchParams,
  options: { withOrganization: boolean },
): ParsedActivitySearch {
  const from = parseCalendarDate(sp.de);
  const to = parseCalendarDate(sp.ate);
  // Comparação de texto vale para AAAA-MM-DD.
  const periodInvalid = from === null || to === null || (from !== undefined && to !== undefined && from > to);
  const cursor = firstValue(sp.antes);

  const filters: ActivityFilters = {};
  const action = parseAuditActionFilter(sp.tipo);
  if (action) filters.action = action;
  if (!periodInvalid) {
    if (from) filters.from = from;
    if (to) filters.to = to;
  }
  if (options.withOrganization) {
    const organizationId = parseOrganizationFilter(sp.organizacao);
    if (organizationId) filters.organizationId = organizationId;
  }

  return {
    filters,
    cursor: cursor ? cursor : undefined,
    periodInvalid,
    periodInput: { from: from ?? undefined, to: to ?? undefined },
  };
}

export function hasActivityFilters(filters: ActivityFilters): boolean {
  return Boolean(filters.action || filters.from || filters.to || filters.organizationId);
}

/**
 * Endereço da página de atividades com os filtros (só os informados). O
 * cursor só entra quando é a navegação para eventos mais antigos com os
 * MESMOS filtros; o formulário de filtros não o envia, então mudar um filtro
 * sempre volta aos mais recentes.
 */
export function activityHref(basePath: string, filters: ActivityFilters = {}, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.action) params.set("tipo", filters.action);
  if (filters.from) params.set("de", filters.from);
  if (filters.to) params.set("ate", filters.to);
  if (filters.organizationId) params.set("organizacao", filters.organizationId);
  if (cursor) params.set("antes", cursor);
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
