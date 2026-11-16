import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconPhone, IconTeam } from "@/components/ui/icons";
import {
  memberStatusLabel,
  memberStatusTone,
  orgStatusLabel,
  orgStatusTone,
  roleLabel,
  roleTone,
  whatsappProviderLabel,
  whatsappStatusLabel,
  whatsappStatusTone,
} from "@/lib/labels";
import type { Organization } from "@/lib/types/database";
import type { OrganizationAdminChannel, OrganizationAdminMember } from "@/modules/organizations/sql-queries";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "America/Sao_Paulo" });

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

export function OrganizationSummary({ organization }: { organization: Organization }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Dados da organização</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-line py-1">
        <InfoRow label="Nome" value={organization.name} />
        <InfoRow label="Identificador" value={organization.slug} />
        <InfoRow
          label="Situação"
          value={<Badge tone={orgStatusTone[organization.status]}>{orgStatusLabel[organization.status]}</Badge>}
        />
        <InfoRow label="Cadastrada em" value={dateFormatter.format(new Date(organization.created_at))} />
      </CardContent>
    </Card>
  );
}

export function OrganizationTeam({ members }: { members: OrganizationAdminMember[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>Equipe ({members.length})</CardTitle>
      </CardHeader>
      {members.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<IconTeam className="size-6" />}
            title="Nenhum membro"
            description="Esta organização ainda não tem usuários vinculados."
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted-2">
                <th className="px-5 py-3 font-medium">Nome</th>
                <th className="px-5 py-3 font-medium">E-mail</th>
                <th className="px-5 py-3 font-medium">Papel</th>
                <th className="px-5 py-3 font-medium">Situação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-surface-2/50">
                  <td className="px-5 py-3 font-medium text-foreground">{member.full_name ?? "—"}</td>
                  <td className="px-5 py-3 text-muted">{member.email ?? "—"}</td>
                  <td className="px-5 py-3">
                    <Badge tone={roleTone[member.role]}>{roleLabel[member.role]}</Badge>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={memberStatusTone[member.status]}>{memberStatusLabel[member.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function OrganizationChannels({ channels }: { channels: OrganizationAdminChannel[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Canal de atendimento</CardTitle>
      </CardHeader>
      {channels.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<IconPhone className="size-6" />}
            title="Nenhum canal cadastrado"
            description="A conexão de canais do WhatsApp será feita em uma entrega futura."
          />
        </div>
      ) : (
        <CardContent className="divide-y divide-line py-1">
          {channels.map((channel) => (
            <div key={channel.id} className="space-y-1 py-2.5">
              <InfoRow label="Nome" value={channel.display_name ?? "—"} />
              <InfoRow label="Número" value={channel.phone_number ?? "—"} />
              <InfoRow label="Tipo" value={whatsappProviderLabel[channel.provider]} />
              <InfoRow
                label="Situação"
                value={<Badge tone={whatsappStatusTone[channel.status]}>{whatsappStatusLabel[channel.status]}</Badge>}
              />
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
