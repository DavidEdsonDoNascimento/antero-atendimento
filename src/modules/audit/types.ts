import type { AuditActorKind } from "@/lib/types/database";

/** Responsável pelo evento, já resolvido para exibição. */
export type AuditEventActor = {
  /** `other` = tipo que esta versão não conhece (preparo da G3): exibido de forma genérica. */
  kind: AuditActorKind | "other";
  /** Nome, "Usuário sem nome", "Usuário removido" ou o texto da manutenção. */
  label: string;
  removed: boolean;
};

export type AuditEventOrganization = {
  id: string;
  /** `null` quando a organização foi excluída (o evento continua no histórico). */
  name: string | null;
  /** Primeiros 8 caracteres do id, para identificar organizações excluídas. */
  shortId: string;
};

/** Evento pronto para a tela: nada de `details` cru, códigos internos ou `db_role`. */
export type AuditEventItem = {
  id: string;
  occurredAt: string;
  /** "Organização suspensa", "Módulo habilitado"… ou "Operação administrativa" para uma ação desconhecida. */
  title: string;
  known: boolean;
  /** Nome do módulo pelo catálogo, quando a operação é de módulo. */
  module: string | null;
  /** Estado anterior e posterior, já traduzidos; `null` quando não se aplica ou não é reconhecido. */
  change: { from: string; to: string } | null;
  organization: AuditEventOrganization;
  actor: AuditEventActor;
};

export type AuditEventPage = {
  items: AuditEventItem[];
  nextCursor: string | null;
};
