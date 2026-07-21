"use client";

import { useFormStatus } from "react-dom";

import { buttonVariants } from "./button";
import { cn } from "@/lib/utils/cn";

type SubmitButtonProps = {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  className?: string;
};

/**
 * Botão de submit que reflete o estado de envio do formulário pai
 * (via `useFormStatus`), exibindo um indicador de carregamento.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className,
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={buttonVariants({ variant, size, className })}
    >
      {pending && (
        <span
          className={cn(
            "size-4 animate-spin rounded-full border-2 border-current border-t-transparent",
          )}
          aria-hidden
        />
      )}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
