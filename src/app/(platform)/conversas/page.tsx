import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { organizationContextOf, requireModule } from "@/lib/auth/dal";
import { parseConversationStatusFilter, parseCursorParam } from "@/modules/conversations/search-params";

import { AutoRefresh } from "./_components/auto-refresh";
import { ConversationsShell } from "./_components/conversations-shell";
import { SimulatorLink } from "./_components/simulator-link";
import { loadConversationList } from "./_lib/loaders";

export const metadata: Metadata = { title: "Conversas" };

type ConversasPageProps = {
  searchParams: Promise<{
    status?: string | string[];
    cursor?: string | string[];
  }>;
};

export default async function ConversasPage({ searchParams }: ConversasPageProps) {
  const context = organizationContextOf(await requireModule("atendimento"));
  const sp = await searchParams;
  const status = parseConversationStatusFilter(sp.status);
  const cursor = parseCursorParam(sp.cursor);

  const listPage = await loadConversationList(context, status, cursor);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Conversas"
        description="Caixa de entrada de atendimento."
        actions={<SimulatorLink />}
      />
      <AutoRefresh />
      <ConversationsShell
        listPage={listPage}
        selectedId={null}
        detailState={{ kind: "none" }}
        status={status}
        cursor={cursor}
      />
    </div>
  );
}
