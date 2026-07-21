import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-gold text-black font-semibold hover:bg-gold-soft focus-visible:ring-gold/60",
  secondary:
    "bg-surface-2 text-foreground border border-line hover:bg-surface-3 focus-visible:ring-gold/40",
  ghost:
    "text-muted hover:text-foreground hover:bg-surface-2 focus-visible:ring-gold/40",
  danger:
    "text-red-300 hover:bg-red-500/10 hover:text-red-200 focus-visible:ring-red-500/40",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function buttonVariants({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-md transition-colors outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-60",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  variant,
  size,
  className,
  ...props
}: ButtonProps) {
  return (
    <button className={buttonVariants({ variant, size, className })} {...props} />
  );
}
