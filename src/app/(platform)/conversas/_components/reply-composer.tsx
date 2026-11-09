"use client";

import { useActionState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { sendReplyAction, type ReplyActionState } from "@/modules/conversations/actions";
import { cn } from "@/lib/utils/cn";

import { ActionFeedback } from "./action-feedback";

const MAX_LENGTH = 4096;

/**
 * Campo de resposta do responsável. `clientMessageId` identifica a mensagem
 * escrita: um envio repetido (duplo clique, nova tentativa após erro de rede)
 * leva a mesma chave e o banco não grava outra mensagem. A Server Action
 * devolve a próxima chave quando uma mensagem foi gravada.
 */
export function ReplyComposer({
  conversationId,
  initialClientMessageId,
  disabledReason,
  simulated,
}: {
  conversationId: string;
  initialClientMessageId: string;
  /** Motivo para não aceitar texto livre agora (ex.: janela encerrada). */
  disabledReason: string | null;
  simulated: boolean;
}) {
  const [state, formAction, pending] = useActionState(sendReplyAction, {
    status: "idle",
    clientMessageId: initialClientMessageId,
    draft: "",
  } satisfies ReplyActionState);
  const disabled = pending || disabledReason !== null;

  return (
    <form action={formAction} className="space-y-2 border-t border-line px-4 py-3">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="clientMessageId" value={state.clientMessageId} />
      {disabledReason && (
        <p role="note" className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          {disabledReason}
        </p>
      )}
      <label htmlFor={`reply-${conversationId}`} className="sr-only">
        Escrever resposta
      </label>
      <textarea
        id={`reply-${conversationId}`}
        name="content"
        required
        rows={3}
        maxLength={MAX_LENGTH}
        defaultValue={state.draft}
        disabled={disabled}
        placeholder={simulated ? "Escreva a resposta (envio simulado)…" : "Escreva a resposta…"}
        className={cn(
          "w-full resize-y rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-foreground",
          "placeholder:text-muted-2 outline-none transition-colors",
          "focus-visible:border-gold/50 focus-visible:ring-2 focus-visible:ring-gold/30",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-2">
          {simulated ? "Canal de desenvolvimento: nada é enviado ao WhatsApp." : "Resposta de texto livre."}
        </p>
        <button type="submit" disabled={disabled} aria-busy={pending} className={buttonVariants({ size: "sm" })}>
          {pending ? "Enviando…" : "Enviar"}
        </button>
      </div>
      <ActionFeedback state={state} />
    </form>
  );
}
