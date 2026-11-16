import type { Organization, OrganizationModule } from "@/lib/types/database";

import { MobileNav } from "./mobile-nav";
import { OrgBadge, PlatformBadge } from "./org-badge";
import { UserMenu } from "./user-menu";

export function Header({
  organization,
  fullName,
  email,
  isPlatformAdmin,
  modules,
}: {
  /** Sem organização: área de administração da plataforma, que não pertence a nenhuma. */
  organization?: Organization;
  fullName: string;
  email: string;
  isPlatformAdmin: boolean;
  modules: OrganizationModule[];
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-background/80 px-4 backdrop-blur md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <MobileNav isPlatformAdmin={isPlatformAdmin} modules={modules} />
        {organization ? <OrgBadge organization={organization} /> : <PlatformBadge />}
      </div>
      <UserMenu fullName={fullName} email={email} />
    </header>
  );
}
