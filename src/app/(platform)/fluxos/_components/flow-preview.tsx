"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { automationEndReasonLabel } from "@/lib/labels";
import { cn } from "@/lib/utils/cn";
import type { OutboundAction } from "@/modules/automations/actions";
import { parseFlowDefinition, type FlowDefinition } from "@/modules/automations/definition";
import { cleanDefinition, editorIssues, hasBlockingIssues, type EditorDefinition } from "@/modules/automations/editor";
import { EMPTY_PREVIEW, previewIsOpen, previewReply, type PreviewConversation, type PreviewEntry } from "@/modules/automations/preview";

import { imageSrc } from "../_lib/image";

type Session = { definition: FlowDefinition; source: string; conversation: PreviewConversation };

function BotAction({
  action,
  interactive,
  onPick,
}: {
  action: OutboundAction;
  interactive: boolean;
  onPick: (row: { id: string; title: string }) => void;
}) {
  if (action.type === "text") return <p className="whitespace-pre-wrap">{action.text}</p>;
  if (action.type === "image") {
    const src = action.mediaId ? imageSrc(action.mediaId) : action.url;
    return (
      <div className="space-y-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element -- prévia da imagem escolhida no editor */}
        <img src={src} alt={action.caption ?? "Imagem"} className="max-h-56 w-full rounded object-cover" />
        {action.caption && <p className="whitespace-pre-wrap">{action.caption}</p>}
      </div>
    );
  }
  const rows = action.sections.flatMap((section) => section.rows);
  return (
    <div className="space-y-2">
      {action.header && <p className="font-semibold">{action.header}</p>}
      <p className="whitespace-pre-wrap">{action.body}</p>
      {action.footer && <p className="text-xs text-muted">{action.footer}</p>}
      <div className="space-y-1 border-t border-line pt-2" role="group" aria-label={action.button}>
        <p className="text-center text-xs font-medium text-sky-300">☰ {action.button}</p>
        {rows.map((row, index) => (
          <button
            key={row.id}
            type="button"
            disabled={!interactive}
            onClick={() => onPick(row)}
            className="block w-full rounded border border-line px-2 py-1.5 text-left text-xs transition-colors enabled:hover:border-gold/40 disabled:opacity-60"
          >
            <span className="text-muted-2">{index + 1}.</span> {row.title}
            {row.description && <span className="block text-[11px] text-muted-2">{row.description}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function SystemNote({ entry }: { entry: Extract<PreviewEntry, { from: "system" }> }) {
  const reason = entry.reason ? automationEndReasonLabel[entry.reason] : null;
  const text =
    entry.status === "handed_off"
      ? "Conversa encaminhada para a equipe. Na operação real, ela iria para a Inbox aguardando atendimento."
      : entry.status === "completed"
        ? `Automação encerrada${reason ? ` (${reason})` : ""}.`
        : `A automação parou por segurança${reason ? ` (${reason})` : ""} e a conversa iria para a equipe.`;
  return <p className="rounded-md border border-dashed border-line px-3 py-2 text-center text-xs text-muted">{text}</p>;
}

/**
 * Prévia do rascunho atual com o motor real (`startSession`/`advance`), só na
 * memória do navegador: nada é enviado, gravado ou mostrado na Inbox.
 */
export function FlowPreview({
  definition,
  humanHandoffAvailable,
  onClose,
}: {
  definition: EditorDefinition;
  humanHandoffAvailable: boolean;
  onClose: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [text, setText] = useState("");
  const source = JSON.stringify(cleanDefinition(definition));
  const issues = editorIssues(definition);
  const blocked = hasBlockingIssues(issues);
  const outdated = session !== null && session.source !== source;
  const conversation = session?.conversation ?? EMPTY_PREVIEW;
  const context = { humanHandoffAvailable };

  function reply(input: { type: "text"; text: string } | { type: "selection"; optionId: string }, shown: string) {
    let current = session;
    if (!current) {
      const parsed = parseFlowDefinition(cleanDefinition(definition));
      if (!parsed.ok) return;
      current = { definition: parsed.definition, source, conversation: EMPTY_PREVIEW };
    }
    setSession({ ...current, conversation: previewReply(current.definition, current.conversation, input, shown, context) });
  }

  const lastListIndex = conversation.entries.findLastIndex((entry) => entry.from === "bot" && entry.action.type === "list");
  const open = previewIsOpen(conversation);
  const answers = conversation.state?.answers ?? [];

  return (
    <section aria-label="Prévia da conversa" className="flex h-full min-h-0 flex-col rounded-lg border border-line bg-surface shadow-2xl shadow-black/60">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Testar conversa</p>
          <p className="text-xs text-muted-2">Prévia do rascunho: nada é enviado nem gravado.</p>
        </div>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setSession(null)} disabled={session === null}>
            Reiniciar
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Fechar a prévia">
            ✕
          </Button>
        </div>
      </div>

      {!humanHandoffAvailable && (
        <p className="border-b border-line px-4 py-2 text-xs text-amber-200">
          Sem o módulo Atendimento: os encaminhamentos mostram a mensagem de indisponibilidade, como na operação real.
        </p>
      )}
      {outdated && (
        <p className="border-b border-line px-4 py-2 text-xs text-sky-200">
          O fluxo mudou desde o início deste teste.{" "}
          <button type="button" className="underline" onClick={() => setSession(null)}>
            Reiniciar com a versão atual
          </button>
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4" aria-live="polite">
        {blocked && session === null ? (
          <div className="space-y-2 text-sm text-muted">
            <p>Corrija os problemas do fluxo para testar a conversa:</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-red-300">
              {issues
                .filter((issue) => issue.severity === "error")
                .slice(0, 5)
                .map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
            </ul>
          </div>
        ) : conversation.entries.length === 0 ? (
          <p className="m-auto max-w-56 text-center text-xs text-muted-2">
            Escreva como se fosse o cliente (por exemplo, “Olá”) para começar.
          </p>
        ) : (
          conversation.entries.map((entry, index) =>
            entry.from === "system" ? (
              <SystemNote key={index} entry={entry} />
            ) : (
              <div
                key={index}
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  entry.from === "customer" ? "self-end bg-gold/15 text-foreground" : "self-start border border-line bg-surface-2 text-foreground",
                )}
              >
                {entry.from === "customer" ? (
                  <p className="whitespace-pre-wrap">{entry.text}</p>
                ) : (
                  <BotAction
                    action={entry.action}
                    interactive={open && index === lastListIndex && !outdated}
                    onPick={(row) => reply({ type: "selection", optionId: row.id }, row.title)}
                  />
                )}
              </div>
            ),
          )
        )}
      </div>

      {answers.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <p className="mb-1 text-xs font-medium text-muted">Dados coletados</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {answers.map((answer) => (
              <div key={answer.key} className="contents">
                <dt className="text-muted-2">{answer.label}</dt>
                <dd className="text-foreground">{answer.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value) return;
          reply({ type: "text", text: value }, value);
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={!open || outdated || (blocked && session === null)}
          placeholder={open ? "Responder como cliente…" : "Conversa encerrada — reinicie para testar de novo"}
          aria-label="Mensagem do cliente"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus-visible:border-gold/50 disabled:opacity-60"
        />
        <Button type="submit" size="sm" disabled={!open || outdated || !text.trim() || (blocked && session === null)}>
          Enviar
        </Button>
      </form>
    </section>
  );
}
