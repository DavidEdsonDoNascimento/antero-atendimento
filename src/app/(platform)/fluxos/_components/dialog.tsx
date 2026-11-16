"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Diálogo modal nativo (`<dialog>`): foco preso, Esc fecha, fundo inerte.
 * `open` controla a abertura; `onClose` é chamado por Esc ou pelo botão.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={titleId}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-foreground backdrop:bg-black/70"
    >
      {/* Fechado, o <dialog> não é exibido nem focável; o conteúdo fica no HTML. */}
      <div className="space-y-4 p-5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
