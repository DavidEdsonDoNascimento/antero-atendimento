import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { requireActiveContext } from "@/lib/auth/dal";
import { parseConversationStatusFilter, parseCursorParam } from "@/modules/conversations/search-params";

import { ConversationsShell } from "./_components/conversations-shell";
import { loadConversationList } from "./_lib/loaders";

export const metadata: Metadata = { title: "Conversas" };

type ConversasPageProps = {
  searchParams: Promise<{
    status?: string | string[];
    cursor?: string | string[];
  }>;
};

export default async function ConversasPage({ searchParams }: ConversasPageProps) {
  const { organization } = await requireActiveContext();
  const sp = await searchParams;
  const status = parseConversationStatusFilter(sp.status);
  const cursor = parseCursorParam(sp.cursor);

  const listPage = await loadConversationList(organization.id, status, cursor);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Conversas"
        description="Caixa de entrada de atendimento — somente leitura."
      />
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
