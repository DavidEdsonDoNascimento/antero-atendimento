import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { requireActiveContext } from "@/lib/auth/dal";
import {
  orgStatusLabel,
  orgStatusTone,
  roleLabel,
  roleTone,
} from "@/lib/labels";

export const metadata: Metadata = { title: "Visão geral" };

const metrics = [
  { label: "Conversas abertas" },
  { label: "Aguardando atendimento" },
  { label: "Em atendimento humano" },
  { label: "Resolvidas recentemente" },
];

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

export default async function VisaoGeralPage() {
  const { organization, role, profile } = await requireActiveContext();
  const firstName = (profile.full_name ?? "").split(" ")[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visão geral"
        description={
          firstName
            ? `Bem-vindo, ${firstName}.`
            : "Resumo da operação de atendimento."
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <StatTile
            key={metric.label}
            label={metric.label}
            value="—"
            hint="Disponível no Ciclo 2"
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Organização</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-line py-1">
            <InfoRow label="Nome" value={organization.name} />
            <InfoRow label="Identificador" value={organization.slug} />
            <InfoRow
              label="Situação"
              value={
                <Badge tone={orgStatusTone[organization.status]}>
                  {orgStatusLabel[organization.status]}
                </Badge>
              }
            />
            <InfoRow
              label="Seu papel"
              value={<Badge tone={roleTone[role]}>{roleLabel[role]}</Badge>}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Próximos passos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted">
            <p>
              A fundação da plataforma está pronta (autenticação, organizações,
              equipe e segurança).
            </p>
            <ul className="space-y-2">
              <li className="flex gap-2">
                <span className="text-gold">•</span>
                <span>
                  <span className="text-foreground">Ciclo 2:</span> caixa de
                  entrada, contatos, mensagens e atendimento simulado.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-gold">•</span>
                <span>
                  <span className="text-foreground">Ciclo 3:</span> motor de
                  automação com níveis e subníveis.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-gold">•</span>
                <span>
                  <span className="text-foreground">Ciclo 4:</span> preparação
                  para o WhatsApp Cloud API real.
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
