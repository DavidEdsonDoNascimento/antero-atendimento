import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { requireActiveContext } from "@/lib/auth/dal";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { organization, profile } = await requireActiveContext();
  const isPlatformAdmin = profile.is_platform_admin;

  return (
    <div className="flex min-h-screen">
      <Sidebar isPlatformAdmin={isPlatformAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          organization={organization}
          fullName={profile.full_name ?? ""}
          email={profile.email}
          isPlatformAdmin={isPlatformAdmin}
        />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
