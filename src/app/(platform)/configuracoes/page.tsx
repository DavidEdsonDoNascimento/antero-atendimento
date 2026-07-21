import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconPhone } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveContext } from "@/lib/auth/dal";
import {
  orgStatusLabel,
  orgStatusTone,
  whatsappProviderLabel,
  whatsappStatusLabel,
  whatsappStatusTone,
} from "@/lib/labels";
import { getPrimaryWhatsappAccount } from "@/modules/whatsapp/queries";

export const metadata: Metadata = { title: "Configurações" };

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right text-sm font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}

export default async function ConfiguracoesPage() {
  const { organization } = await requireActiveContext();
  const whatsapp = await getPrimaryWhatsappAccount(organization.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configurações"
        description="Dados da organização e do canal de atendimento."
      />

      <Card>
        <CardHeader>
          <CardTitle>Dados da organização</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-line py-1">
          <InfoRow label="Nome" value={organization.name} />
          <InfoRow label="Identificador (slug)" value={organization.slug} />
          <InfoRow
            label="Situação"
            value={
              <Badge tone={orgStatusTone[organization.status]}>
                {orgStatusLabel[organization.status]}
              </Badge>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Canal de WhatsApp</CardTitle>
        </CardHeader>
        <CardContent>
          {whatsapp ? (
            <div className="divide-y divide-line py-1">
              <InfoRow
                label="Provedor"
                value={
                  <Badge tone="gold">
                    {whatsappProviderLabel[whatsapp.provider]}
                  </Badge>
                }
              />
              <InfoRow
                label="Nome exibido"
                value={whatsapp.display_name ?? "—"}
              />
              <InfoRow
                label="Telefone"
                value={whatsapp.phone_number ?? "Não configurado"}
              />
              <InfoRow
                label="Conexão"
                value={
                  <Badge tone={whatsappStatusTone[whatsapp.status]}>
                    {whatsappStatusLabel[whatsapp.status]}
                  </Badge>
                }
              />
            </div>
          ) : (
            <EmptyState
              icon={<IconPhone className="size-6" />}
              title="Nenhum canal configurado"
              description="A conta de WhatsApp da organização ainda não foi criada."
            />
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-2">
        A integração real com o WhatsApp Cloud API será adicionada no Ciclo 4.
        Enquanto isso, o provedor de desenvolvimento permite simular
        conversas sem depender de credenciais externas. A edição destes dados
        pela interface chega em um ciclo futuro.
      </p>
    </div>
  );
}
