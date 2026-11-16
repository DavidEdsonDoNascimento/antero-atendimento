"use client";

import { useActionState, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { restoreVersionAction, type RestoreState } from "@/modules/automations/editor-actions";

import { Dialog } from "./dialog";

const INITIAL: RestoreState = { status: "idle" };

/** Carrega uma versão publicada como rascunho, depois de confirmar. Nada é publicado aqui. */
export function RestoreForm({
  flowId,
  version,
  draftRevision,
  draftHasChanges,
}: {
  flowId: string;
  version: number;
  draftRevision: number;
  draftHasChanges: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(restoreVersionAction, INITIAL);
  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={pending}>
        {pending ? "Restaurando…" : "Restaurar esta versão"}
      </Button>
      {state.status !== "idle" && (
        <p role="alert" className="text-xs text-red-300">
          {state.message}
        </p>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={`Restaurar a versão ${version}?`}>
        <div className="space-y-2 text-sm text-muted">
          <p>O conteúdo da versão {version} será carregado no editor como rascunho.</p>
          {draftHasChanges && (
            <p className="text-amber-200">O rascunho atual tem alterações não publicadas, que serão substituídas.</p>
          )}
          <p>
            Nada muda para os clientes até você publicar. Ao publicar, ele vira uma versão nova — as versões
            anteriores continuam guardadas como estão.
          </p>
        </div>
        <form action={formAction} onSubmit={() => setOpen(false)} className="flex justify-end gap-2">
          <input type="hidden" name="flowId" value={flowId} />
          <input type="hidden" name="version" value={version} />
          <input type="hidden" name="expectedRevision" value={draftRevision} />
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <button type="submit" className={buttonVariants({})}>
            Carregar como rascunho
          </button>
        </form>
      </Dialog>
    </div>
  );
}
