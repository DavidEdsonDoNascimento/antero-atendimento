import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconFlows } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { organizationContextOf, requireModule } from "@/lib/auth/dal";
import { automationFlowStatusLabel, automationFlowStatusTone } from "@/lib/labels";
import { listFlows } from "@/modules/automations/sql-queries";

export const metadata: Metadata = { title: "Automações" };

/**
 * Fluxos da organização, só leitura. O motor já executa os fluxos publicados
 * (hoje, pelo simulador); criar e editar pela tela chega com o editor (E3B).
 */
export default async function FluxosPage() {
  const context = organizationContextOf(await requireModule("automacoes"));
  const flows = await listFlows(context);

  return (
    <div className="space-y-6">
      <PageHeader title="Automações" description="Fluxos, menus e respostas automáticas." />
      {flows.length === 0 ? (
        <EmptyState
          icon={<IconFlows className="size-6" />}
          title="Nenhum fluxo publicado"
          description="O editor de fluxos chega na próxima entrega. Até lá, os fluxos são criados pela equipe da Antero."
        />
      ) : (
        <Card className="divide-y divide-line">
          {flows.map((flow) => (
            <div key={flow.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium text-foreground">{flow.name}</p>
                <p className="text-xs text-muted-2">
                  {flow.slug}
                  {flow.isEntry && " · responde às conversas novas"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={automationFlowStatusTone[flow.status]}>{automationFlowStatusLabel[flow.status]}</Badge>
                <span>{flow.publishedVersion ? `versão ${flow.publishedVersion}` : "não publicado"}</span>
                <span aria-hidden>·</span>
                <span>{flow.activeSessions} em andamento</span>
              </div>
            </div>
          ))}
        </Card>
      )}
      <p className="text-xs text-muted-2">
        Editar fluxos pela tela chega na próxima entrega. Uma conversa em andamento continua na versão em que começou.
      </p>
    </div>
  );
}
