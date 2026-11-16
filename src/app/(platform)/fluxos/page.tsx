import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconFlows } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { organizationContextOf, requireModule } from "@/lib/auth/dal";
import { automationFlowStatusLabel, automationFlowStatusTone } from "@/lib/labels";
import { listFlows } from "@/modules/automations/sql-queries";

import { FlowStatusForm } from "./_components/flow-status-form";
import { formatDateTime } from "./_lib/format";

export const metadata: Metadata = { title: "Automações" };

/**
 * Automações da organização. Owner/admin criam, editam, publicam e pausam;
 * os demais membros com o módulo só consultam.
 */
export default async function FluxosPage() {
  const active = await requireModule("automacoes");
  const canEdit = active.role === "owner" || active.role === "admin";
  const flows = await listFlows(organizationContextOf(active));
  const createLink = canEdit && (
    <Link href="/fluxos/novo" className={buttonVariants({})}>
      Criar automação
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Automações"
        description="Mensagens, menus e perguntas que respondem seus clientes automaticamente."
        actions={flows.length > 0 ? createLink : undefined}
      />
      {!active.modules.includes("atendimento") && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-100">
          Sua organização não tem o módulo Atendimento: as automações funcionam, mas não conseguem passar a conversa
          para a equipe. Nas etapas de encaminhamento, o cliente recebe a mensagem de indisponibilidade.
        </p>
      )}
      {flows.length === 0 ? (
        <EmptyState
          icon={<IconFlows className="size-6" />}
          title="Nenhuma automação ainda"
          description={
            canEdit
              ? "Crie uma automação com mensagem de boas-vindas, menu de opções e encaminhamento para a equipe — sem programar."
              : "Proprietários e administradores da organização podem criar automações."
          }
          action={createLink || undefined}
        />
      ) : (
        <Card className="divide-y divide-line">
          {flows.map((flow) => (
            <div key={flow.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {canEdit ? (
                    <Link href={`/fluxos/${flow.id}`} className="truncate text-sm font-medium text-foreground hover:text-gold-soft">
                      {flow.name}
                    </Link>
                  ) : (
                    <p className="truncate text-sm font-medium text-foreground">{flow.name}</p>
                  )}
                  <Badge tone={automationFlowStatusTone[flow.status]}>{automationFlowStatusLabel[flow.status]}</Badge>
                  {flow.isEntry && <Badge tone="gold">Responde às conversas novas</Badge>}
                  {flow.publishedVersion !== null && flow.hasDraftChanges && <Badge tone="blue">Alterações não publicadas</Badge>}
                </div>
                <p className="text-xs text-muted-2">
                  {flow.publishedVersion
                    ? `Versão ${flow.publishedVersion}, publicada em ${formatDateTime(flow.publishedAt!)}`
                    : "Ainda não publicada"}
                  {" · "}
                  rascunho salvo em {formatDateTime(flow.draftUpdatedAt)}
                  {" · "}
                  {flow.activeSessions} {flow.activeSessions === 1 ? "conversa em andamento" : "conversas em andamento"}
                </p>
              </div>
              {canEdit && (
                <div className="flex flex-wrap items-start gap-2">
                  <Link href={`/fluxos/${flow.id}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                    Editar
                  </Link>
                  {flow.publishedVersion !== null && (
                    <Link href={`/fluxos/${flow.id}/versoes`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                      Versões
                    </Link>
                  )}
                  <FlowStatusForm flowId={flow.id} status={flow.status} />
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
      <p className="text-xs text-muted-2">
        Uma conversa em andamento continua na versão em que começou. Pausar uma automação passa as conversas em
        andamento para a equipe na próxima mensagem do cliente.
      </p>
    </div>
  );
}
