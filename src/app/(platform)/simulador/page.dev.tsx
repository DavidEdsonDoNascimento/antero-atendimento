import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/ui/empty-state";
import { IconConversations } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveContext } from "@/lib/auth/dal";
import { AccessDeniedError } from "@/lib/db";
import { isSimulatorEnabled } from "@/lib/dev-environment";
import { listFlows } from "@/modules/automations/sql-queries";
import { listSimulatorChannels, listSimulatorContacts } from "@/modules/simulator/sql-queries";

import { SimulatorForm, type SimulatorAutomation } from "./_components/simulator-form";

export const metadata: Metadata = { title: "Simulador de mensagens" };

/**
 * Simulador de WhatsApp — SÓ desenvolvimento e testes. Extensão `.dev.tsx`: a
 * rota só é compilada no `next dev` (`pageExtensions` em next.config.ts), então
 * não existe no build de produção; a checagem abaixo e a da Server Action são a
 * segunda camada. O canal escolhido na URL só é aceito se estiver na lista do
 * usuário (owner/admin ativo, canal development conectado), e o banco confere
 * de novo ao gravar.
 */
export default async function SimuladorPage({
  searchParams,
}: {
  searchParams: Promise<{ canal?: string | string[] }>;
}) {
  if (!isSimulatorEnabled()) notFound();
  const { userId, organization } = await requireActiveContext();
  const channels = await listSimulatorChannels({ userId });
  const requested = (await searchParams).canal;
  const selected = channels.find((channel) => channel.id === requested) ?? channels[0] ?? null;
  const contacts = selected ? await listSimulatorContacts({ userId }, selected.id) : [];
  // Fluxo de entrada da organização do canal (null = módulo Automações desabilitado).
  let entryFlow: SimulatorAutomation = null;
  if (selected) {
    try {
      const flows = await listFlows({ userId, organizationId: selected.organization_id });
      entryFlow = { enabled: true, flow: flows.find((flow) => flow.isEntry) ?? null };
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      entryFlow = { enabled: false, flow: null };
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Simulador de mensagens"
        description="Ambiente de desenvolvimento: envia mensagens como se fossem de um cliente, sem a Meta e sem WhatsApp real."
      />
      {selected ? (
        <SimulatorForm
          key={selected.id}
          channels={channels}
          selected={selected}
          contacts={contacts}
          activeOrganizationId={organization.id}
          automation={entryFlow}
        />
      ) : (
        <EmptyState
          icon={<IconConversations className="size-6" />}
          title="Nenhum canal disponível para simulação"
          description="O simulador usa canais de desenvolvimento conectados de organizações em que você é owner ou admin ativo."
        />
      )}
    </div>
  );
}
