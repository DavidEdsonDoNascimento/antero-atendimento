import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { getProfile } from "@/lib/auth/dal";

/**
 * Acesso ao admin da plataforma nas telas sem organização ativa: o papel não
 * depende de vínculo, e é por lá que uma organização é reativada.
 */
export async function PlatformAdminLink() {
  const profile = await getProfile();
  if (!profile?.is_platform_admin) return null;
  return (
    <Link href="/admin" className={buttonVariants({ variant: "primary", size: "md" })}>
      Admin da plataforma
    </Link>
  );
}
