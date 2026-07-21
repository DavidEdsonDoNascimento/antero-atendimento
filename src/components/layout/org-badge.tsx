import { cn } from "@/lib/utils/cn";
import type { Organization } from "@/lib/types/database";

export function OrgBadge({ organization }: { organization: Organization }) {
  const active = organization.status === "active";
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-xs font-semibold text-gold">
        {organization.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {organization.name}
        </p>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              active ? "bg-emerald-400" : "bg-muted-2",
            )}
          />
          {active ? "Ativa" : "Inativa"} · {organization.slug}
        </p>
      </div>
    </div>
  );
}
