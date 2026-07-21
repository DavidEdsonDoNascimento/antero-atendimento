import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconTeam } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveContext } from "@/lib/auth/dal";
import {
  memberStatusLabel,
  memberStatusTone,
  roleLabel,
  roleTone,
} from "@/lib/labels";
import { listOrganizationMembers } from "@/modules/users/queries";

export const metadata: Metadata = { title: "Equipe" };

export default async function EquipePage() {
  const { organization } = await requireActiveContext();
  const members = await listOrganizationMembers(organization.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Equipe"
        description="Usuários com acesso a esta organização."
      />

      {members.length === 0 ? (
        <EmptyState
          icon={<IconTeam className="size-6" />}
          title="Nenhum membro encontrado"
          description="Vincule usuários a esta organização seguindo o procedimento em docs/SETUP.md."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted-2">
                  <th className="px-5 py-3 font-medium">Nome</th>
                  <th className="px-5 py-3 font-medium">E-mail</th>
                  <th className="px-5 py-3 font-medium">Papel</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {members.map((member) => (
                  <tr key={member.id} className="hover:bg-surface-2/50">
                    <td className="px-5 py-3 font-medium text-foreground">
                      {member.profile?.full_name ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-muted">
                      {member.profile?.email ?? "—"}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={roleTone[member.role]}>
                        {roleLabel[member.role]}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={memberStatusTone[member.status]}>
                        {memberStatusLabel[member.status]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-2">
        O convite de usuários por e-mail chega em um ciclo futuro. Por enquanto,
        o vínculo é feito de forma administrativa (veja docs/SETUP.md).
      </p>
    </div>
  );
}
