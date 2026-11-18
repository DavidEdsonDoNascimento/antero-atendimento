import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconShield } from "@/components/ui/icons";
import { auditActorKindLabel, auditActorKindTone } from "@/lib/labels";
import { InvalidAuditCursorError } from "@/modules/audit/errors";
import { DELETED_ORGANIZATION_LABEL } from "@/modules/audit/mappers";
import { activityHref, hasActivityFilters, type ActivityFilters } from "@/modules/audit/search-params";
import { listAuditEvents } from "@/modules/audit/sql-queries";
import type { AuditEventItem, AuditEventPage } from "@/modules/audit/types";

import { formatDateTime } from "../_lib/format";

function ActorBadge({ kind }: { kind: AuditEventItem["actor"]["kind"] }) {
  if (kind === "other") return <Badge tone="zinc">Outro responsável</Badge>;
  return <Badge tone={auditActorKindTone[kind]}>{auditActorKindLabel[kind]}</Badge>;
}

function EventOrganization({ organization }: { organization: AuditEventItem["organization"] }) {
  if (organization.name === null) {
    return (
      <span className="text-muted-2">
        {DELETED_ORGANIZATION_LABEL} · {organization.shortId}
      </span>
    );
  }
  return (
    <Link href={`/admin/organizacoes/${organization.id}`} className="text-foreground hover:text-gold-soft hover:underline">
      {organization.name}
    </Link>
  );
}

function EventRow({ item, showOrganization }: { item: AuditEventItem; showOrganization: boolean }) {
  return (
    <li className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          {item.title}
          {item.module && <span className="font-normal text-muted"> · {item.module}</span>}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.change && (
            <Badge tone="zinc">
              {item.change.from} → {item.change.to}
            </Badge>
          )}
          <ActorBadge kind={item.actor.kind} />
        </div>
        <p className="text-sm text-muted">
          Responsável:{" "}
          <span className={item.actor.removed ? "text-muted-2" : "text-foreground"}>{item.actor.label}</span>
          {showOrganization && (
            <>
              {" · "}Organização: <EventOrganization organization={item.organization} />
            </>
          )}
        </p>
      </div>
      <div className="shrink-0 text-xs text-muted sm:text-right">
        <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
        <p className="text-muted-2">Registro #{item.id}</p>
      </div>
    </li>
  );
}

/**
 * Uma página do histórico (consulta no servidor, 25 por vez). Fica dentro de
 * `<Suspense>` na página, DEPOIS da autorização e do `notFound()`, para o 404
 * continuar com status 404 (um `loading.tsx` faria a resposta começar antes).
 * Cursor inválido ou adulterado volta aos mais recentes, como na Inbox.
 */
export async function ActivityList({
  userId,
  basePath,
  filters,
  scope,
  cursor,
  showOrganization,
}: {
  userId: string;
  basePath: string;
  /** Filtros escolhidos na URL (entram nos links). */
  filters: ActivityFilters;
  /** Restrição fixa da rota (organização do detalhe); não entra nos links. */
  scope?: { organizationId: string };
  cursor?: string;
  showOrganization: boolean;
}) {
  const query = { ...filters, ...scope };
  let page: AuditEventPage;
  let cursorRejected = false;
  try {
    page = await listAuditEvents({ userId }, { filters: query, cursor });
  } catch (error) {
    if (!(error instanceof InvalidAuditCursorError)) throw error;
    cursorRejected = true;
    page = await listAuditEvents({ userId }, { filters: query });
  }
  const paged = cursor !== undefined && !cursorRejected;
  const latestHref = activityHref(basePath, filters);

  const notice = cursorRejected && (
    <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
      O endereço da página não é válido. Mostrando os eventos mais recentes.
    </p>
  );

  if (page.items.length === 0) {
    return (
      <div className="space-y-3">
        {notice}
        {paged ? (
          <EmptyState
            icon={<IconShield className="size-6" />}
            title="Não há eventos mais antigos"
            description="Todos os eventos destes filtros já foram exibidos."
            action={
              <Link href={latestHref} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Voltar aos mais recentes
              </Link>
            }
          />
        ) : hasActivityFilters(filters) ? (
          <EmptyState
            icon={<IconShield className="size-6" />}
            title="Nenhuma atividade com esses filtros"
            description="Nenhum evento combina com o tipo, o período e a organização escolhidos."
            action={
              <Link href={basePath} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Limpar filtros
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={<IconShield className="size-6" />}
            title="Nenhuma atividade registrada"
            description="Suspensões, reativações e alterações de módulos aparecem aqui assim que acontecem."
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {notice}
      <Card className="overflow-hidden">
        <ol aria-label="Atividades administrativas" className="divide-y divide-line">
          {page.items.map((item) => (
            <EventRow key={item.id} item={item} showOrganization={showOrganization} />
          ))}
        </ol>
      </Card>
      {(paged || page.nextCursor) && (
        <nav aria-label="Paginação das atividades" className="flex flex-wrap items-center justify-between gap-3">
          {paged ? (
            <Link href={latestHref} className="text-sm text-muted hover:text-foreground">
              ← Voltar aos mais recentes
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor && (
            <Link
              href={activityHref(basePath, filters, page.nextCursor)}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Eventos mais antigos →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}

export function ActivityListSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Carregando atividades">
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-start justify-between gap-6 border-b border-line px-5 py-4 last:border-b-0">
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 animate-pulse rounded bg-surface-2" />
              <div className="h-4 w-72 max-w-full animate-pulse rounded bg-surface-2" />
            </div>
            <div className="h-4 w-28 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
