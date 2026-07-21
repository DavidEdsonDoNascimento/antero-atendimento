import { cn } from "@/lib/utils/cn";

/**
 * Marca da Antero — mark geométrico + wordmark.
 * Placeholder tipográfico premium; substituível pela identidade oficial.
 */
export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-md border border-gold/30 bg-gradient-to-br from-surface-3 to-surface text-gold"
      >
        <span className="text-sm font-bold tracking-tight">A</span>
      </span>
      {showWordmark && (
        <span className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            Antero
          </span>
          <span className="text-[11px] font-medium text-muted-2">
            Atendimento
          </span>
        </span>
      )}
    </span>
  );
}
