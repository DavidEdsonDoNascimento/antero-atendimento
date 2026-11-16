import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireModule } from "@/lib/auth/dal";
import { getFlowForEditor, listFlowVersions } from "@/modules/automations/sql-queries";

import { AdminOnly } from "../../_components/admin-only";
import { RestoreForm } from "../../_components/restore-form";
import { formatDateTime } from "../../_lib/format";
import { flowEditorContext } from "../../_lib/load";

export const metadata: Metadata = { title: "Versões da automação" };

export default async function VersoesPage({ params }: { params: Promise<{ flowId: string }> }) {
  const { context, flowId, canEdit } = flowEditorContext(await requireModule("automacoes"), (await params).flowId);
  if (!canEdit) return <AdminOnly />;
  const [flow, versions] = await Promise.all([getFlowForEditor(context, flowId), listFlowVersions(context, flowId)]);
  if (!flow) notFound();

  return (
    <div className="space-y-6">
      <Link href={`/fluxos/${flowId}`} className="text-xs text-muted hover:text-foreground">
        ← {flow.name}
      </Link>
      <PageHeader
        title="Histórico de versões"
        description="Cada publicação fica guardada como está. Restaurar carrega uma versão antiga como rascunho, para revisar e publicar de novo."
      />
      {versions.length === 0 ? (
        <EmptyState title="Nenhuma versão publicada" description="Publique a automação pelo editor para criar a primeira versão." />
      ) : (
        <Card className="divide-y divide-line">
          {versions.map((version) => (
            <div key={version.version} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-0.5">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  Versão {version.version}
                  {version.isCurrent && <Badge tone="green">Em uso</Badge>}
                </p>
                <p className="text-xs text-muted-2">
                  Publicada em {formatDateTime(version.publishedAt)} por {version.publishedByName ?? "ex-membro da equipe"}
                </p>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <Link href={`/fluxos/${flowId}/versoes/${version.version}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  Ver conteúdo
                </Link>
                <RestoreForm flowId={flowId} version={version.version} draftRevision={flow.draftRevision} draftHasChanges={flow.hasDraftChanges} />
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
