import type { Organization } from "@/lib/types/database";

import { MobileNav } from "./mobile-nav";
import { OrgBadge } from "./org-badge";
import { UserMenu } from "./user-menu";

export function Header({
  organization,
  fullName,
  email,
  isPlatformAdmin,
}: {
  organization: Organization;
  fullName: string;
  email: string;
  isPlatformAdmin: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-background/80 px-4 backdrop-blur md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <MobileNav isPlatformAdmin={isPlatformAdmin} />
        <OrgBadge organization={organization} />
      </div>
      <UserMenu fullName={fullName} email={email} />
    </header>
  );
}
