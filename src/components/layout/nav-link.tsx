"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils/cn";

export function NavLink({
  href,
  label,
  icon,
  soon,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  soon?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-surface-2 text-foreground"
          : "text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-gold"
        />
      )}
      <span
        className={cn(
          "shrink-0",
          active ? "text-gold" : "text-muted-2 group-hover:text-muted",
        )}
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {soon && (
        <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-medium text-muted-2">
          {soon}
        </span>
      )}
    </Link>
  );
}
