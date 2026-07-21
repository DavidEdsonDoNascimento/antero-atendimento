import { Logo } from "@/components/ui/logo";

import { adminNav, mainNav } from "./nav-config";
import { NavLink } from "./nav-link";

export function Sidebar({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface/30 md:flex">
      <div className="flex h-16 items-center border-b border-line px-5">
        <Logo />
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {mainNav.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            soon={item.soon}
            icon={<item.icon className="size-[18px]" />}
          />
        ))}

        {isPlatformAdmin && (
          <div className="pt-4">
            <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-2">
              Plataforma
            </p>
            <NavLink
              href={adminNav.href}
              label={adminNav.label}
              icon={<adminNav.icon className="size-[18px]" />}
            />
          </div>
        )}
      </nav>
      <div className="border-t border-line px-5 py-3 text-[11px] text-muted-2">
        MVP · Ciclo 1
      </div>
    </aside>
  );
}
