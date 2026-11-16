import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireModule } from "@/lib/auth/dal";
import { toEditorDefinition } from "@/modules/automations/editor";
import { getFlowForEditor, getFlowVersion } from "@/modules/automations/sql-queries";

import { AdminOnly } from "../../../_components/admin-only";
import { FlowOutline } from "../../../_components/flow-outline";
import { RestoreForm } from "../../../_components/restore-form";
import { formatDateTime } from "../../../_lib/format";
import { flowEditorContext } from "../../../_lib/load";

export const metadata: Metadata = { title: "Versão da automação" };

export default async function VersaoPage({ params }: { params: Promise<{ flowId: string; version: string }> }) {
  const raw = await params;
  const { context, flowId, canEdit } = flowEditorContext(await requireModule("automacoes"), raw.flowId);
  if (!canEdit) return <AdminOnly />;
  const number = Number(raw.version);
  if (!Number.isInteger(number) || number < 1) notFound();
  const [flow, version] = await Promise.all([getFlowForEditor(context, flowId), getFlowVersion(context, flowId, number)]);
  if (!flow || !version) notFound();
  const definition = toEditorDefinition(version.definition);

  return (
    <div className="space-y-6">
      <Link href={`/fluxos/${flowId}/versoes`} className="text-xs text-muted hover:text-foreground">
        ← Histórico de versões
      </Link>
      <PageHeader
        title={`${flow.name} — versão ${version.version}`}
        description={`Publicada em ${formatDateTime(version.publishedAt)} por ${version.publishedByName ?? "ex-membro da equipe"}. Só leitura: versões publicadas não mudam.`}
        actions={
          <div className="flex items-start gap-2">
            {version.isCurrent && <Badge tone="green">Em uso</Badge>}
            <RestoreForm flowId={flowId} version={version.version} draftRevision={flow.draftRevision} draftHasChanges={flow.hasDraftChanges} />
          </div>
        }
      />
      {definition ? <FlowOutline definition={definition} /> : <Card className="p-5 text-sm text-red-200">Conteúdo ilegível.</Card>}
    </div>
  );
}
