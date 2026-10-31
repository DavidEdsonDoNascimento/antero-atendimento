import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { SignOutForm } from "@/components/layout/sign-out-form";
import { Logo } from "@/components/ui/logo";
import { getActiveContext, requirePlatformAdmin } from "@/lib/auth/dal";

/**
 * Admin da plataforma fora do layout de `(platform)`, que exige organização
 * ativa: o papel não depende de vínculo, e quem pertence só a uma organização
 * suspensa precisa continuar chegando aqui para reativá-la.
 */
export default async function PlatformAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requirePlatformAdmin();
  const context = await getActiveContext();

  return (
    <div className="flex min-h-screen">
      {context && <Sidebar isPlatformAdmin modules={context.modules} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {context ? (
          <Header
            organization={context.organization}
            fullName={profile.full_name ?? ""}
            email={profile.email}
            isPlatformAdmin
            modules={context.modules}
          />
        ) : (
          <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 md:px-6">
            <Logo />
            <SignOutForm />
          </header>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
