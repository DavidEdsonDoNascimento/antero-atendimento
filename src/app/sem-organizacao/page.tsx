import type { Metadata } from "next";

import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/ui/logo";
import { SignOutForm } from "@/components/layout/sign-out-form";
import { requireUser } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Sem organização" };

export default async function SemOrganizacaoPage() {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardContent className="space-y-4 p-6">
            <h1 className="text-lg font-semibold text-foreground">
              Nenhuma organização vinculada
            </h1>
            <p className="text-sm text-muted">
              Sua conta ({user.email}) foi autenticada, mas ainda não está
              associada a nenhuma organização ativa. Um administrador precisa
              vincular seu usuário a uma organização.
            </p>
            <p className="text-sm text-muted">
              Consulte <code className="text-gold-soft">docs/SETUP.md</code> para
              o procedimento de vínculo do primeiro usuário.
            </p>
            <SignOutForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
