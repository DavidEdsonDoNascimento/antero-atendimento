import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card } from "@/components/ui/card";
import { toEditorDefinition } from "@/modules/automations/editor";
import { getFlowForEditor, listFlowImages } from "@/modules/automations/sql-queries";

import { AdminOnly } from "../_components/admin-only";
import { FlowEditor } from "../_components/flow-editor";
import { requireFlowEditor } from "../_lib/load";

export const metadata: Metadata = { title: "Editar automação" };

export default async function EditarAutomacaoPage({
  params,
  searchParams,
}: {
  params: Promise<{ flowId: string }>;
  searchParams: Promise<{ restaurada?: string }>;
}) {
  const { active, context, flowId, canEdit } = await requireFlowEditor((await params).flowId);
  if (!canEdit) return <AdminOnly />;
  const [flow, images] = await Promise.all([getFlowForEditor(context, flowId), listFlowImages(context)]);
  if (!flow) notFound();
  const definition = toEditorDefinition(flow.draftDefinition);
  if (!definition) {
    return (
      <Card className="p-5 text-sm text-red-200">
        O rascunho desta automação não pôde ser aberto pelo editor. Restaure uma versão publicada pelo histórico.
      </Card>
    );
  }
  const restored = Number((await searchParams).restaurada);

  return (
    <FlowEditor
      flow={{
        id: flow.id,
        name: flow.name,
        status: flow.status,
        isEntry: flow.isEntry,
        otherEntryFlowName: flow.otherEntryFlowName,
        draftRevision: flow.draftRevision,
        publishedVersion: flow.publishedVersion,
        hasDraftChanges: flow.hasDraftChanges,
      }}
      initialDefinition={definition}
      images={images.map((image) => ({ id: image.id, fileName: image.fileName }))}
      humanHandoffAvailable={active.modules.includes("atendimento")}
      restoredVersion={Number.isInteger(restored) && restored > 0 ? restored : null}
    />
  );
}
