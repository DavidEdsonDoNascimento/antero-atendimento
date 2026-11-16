import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { organizationContextOf, requireModule } from "@/lib/auth/dal";
import { getEntryFlowName } from "@/modules/automations/sql-queries";

import { CreateFlowForm } from "../_components/create-flow-form";

export const metadata: Metadata = { title: "Criar automação" };

export default async function NovaAutomacaoPage() {
  const active = await requireModule("automacoes");
  if (active.role !== "owner" && active.role !== "admin") redirect("/fluxos");
  const entryFlowName = await getEntryFlowName(organizationContextOf(active));
  return (
    <div className="space-y-6">
      <Link href="/fluxos" className="text-xs text-muted hover:text-foreground">
        ← Automações
      </Link>
      <PageHeader title="Criar automação" description="Dê um nome e comece por um fluxo pronto para ajustar." />
      <CreateFlowForm entryFlowName={entryFlowName} />
    </div>
  );
}
