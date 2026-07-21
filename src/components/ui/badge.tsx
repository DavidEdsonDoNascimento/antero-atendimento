import { cn } from "@/lib/utils/cn";

export type BadgeTone =
  | "gold"
  | "green"
  | "amber"
  | "blue"
  | "zinc"
  | "red";

const toneClasses: Record<BadgeTone, string> = {
  gold: "bg-gold/10 text-gold-soft border-gold/20",
  green: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  amber: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  blue: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  zinc: "bg-surface-3 text-muted border-line",
  red: "bg-red-500/10 text-red-300 border-red-500/20",
};

export function Badge({
  tone = "zinc",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
