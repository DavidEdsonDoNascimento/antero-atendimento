import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PlatformAdminLink } from "@/components/layout/platform-admin-link";
import { SignOutForm } from "@/components/layout/sign-out-form";
import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/ui/logo";
import { getActiveContext, getSuspendedOrganizations, requireUser } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Organização suspensa" };

export default async function OrganizacaoSuspensaPage() {
  const user = await requireUser();
  const [context, suspended] = await Promise.all([getActiveContext(), getSuspendedOrganizations()]);
  // Reativada, ou com outra organização ativa: esta tela não se aplica.
  if (context || suspended.length === 0) redirect("/visao-geral");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardContent className="space-y-4 p-6">
            <h1 className="text-lg font-semibold text-foreground">
              Organização suspensa
            </h1>
            <p className="text-sm text-muted">
              O acesso de {user.email} a{" "}
              <strong className="font-medium text-foreground">
                {suspended.map((organization) => organization.name).join(", ")}
              </strong>{" "}
              está suspenso no momento. Os dados da organização estão preservados
              e voltam a ficar disponíveis quando ela for reativada.
            </p>
            <p className="text-sm text-muted">
              Para regularizar, fale com o responsável pela sua organização ou
              com o suporte da Antero Sistemas.
            </p>
            <PlatformAdminLink />
            <SignOutForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
