import { STEP_TYPE_LABEL, stepLabel, type EditorDefinition, type EditorStep } from "@/modules/automations/editor";

import { imageSrc } from "../_lib/image";

function target(definition: EditorDefinition, id: string | undefined): string {
  if (!id) return "encerrar";
  const step = definition.steps.find((candidate) => candidate.id === id);
  return step ? stepLabel(step) : "etapa excluída";
}

function Body({ definition, step }: { definition: EditorDefinition; step: EditorStep }) {
  const next = (id: string | undefined) => <p className="text-xs text-muted-2">→ {target(definition, id)}</p>;
  switch (step.type) {
    case "message":
      return (
        <>
          <p className="whitespace-pre-wrap text-sm text-foreground">{step.text}</p>
          {next(step.next)}
        </>
      );
    case "image":
      return (
        <>
          {step.mediaId ? (
            // eslint-disable-next-line @next/next/no-img-element -- imagem privada da organização
            <img src={imageSrc(step.mediaId)} alt="" className="max-h-40 rounded object-cover" />
          ) : (
            <p className="break-all text-xs text-muted">{step.url}</p>
          )}
          {step.caption && <p className="whitespace-pre-wrap text-sm text-foreground">{step.caption}</p>}
          {next(step.next)}
        </>
      );
    case "menu":
      return (
        <>
          {step.header && <p className="text-sm font-medium text-foreground">{step.header}</p>}
          <p className="whitespace-pre-wrap text-sm text-foreground">{step.text}</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-sm text-foreground">
            {step.options.map((option) => (
              <li key={option.id}>
                {option.title} <span className="text-xs text-muted-2">→ {target(definition, option.next)}</span>
              </li>
            ))}
          </ol>
          {(step.showBack || step.showMainMenu) && (
            <p className="text-xs text-muted-2">
              Também mostra: {[step.showBack && definition.settings.backLabel, step.showMainMenu && definition.settings.mainMenuLabel].filter(Boolean).join(", ")}
            </p>
          )}
        </>
      );
    case "question":
      return (
        <>
          <p className="whitespace-pre-wrap text-sm text-foreground">{step.text}</p>
          <p className="text-xs text-muted">Guarda como: {step.label}</p>
          {next(step.next)}
        </>
      );
    case "handoff":
      return (
        <>
          <p className="whitespace-pre-wrap text-sm text-foreground">{step.text || definition.settings.handoffMessage}</p>
          <p className="text-xs text-muted-2">Sem atendimento humano → {target(definition, step.unavailableNext || undefined)}</p>
        </>
      );
    case "end":
      return step.text ? <p className="whitespace-pre-wrap text-sm text-foreground">{step.text}</p> : <p className="text-xs text-muted-2">Sem mensagem final.</p>;
  }
}

/** Conteúdo de um fluxo, só para leitura (histórico de versões). */
export function FlowOutline({ definition }: { definition: EditorDefinition }) {
  return (
    <ol className="space-y-3">
      {definition.steps.map((step) => (
        <li key={step.id} className="space-y-1.5 rounded-lg border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-gold-soft">{STEP_TYPE_LABEL[step.type]}</span>
            <span className="text-sm font-medium text-foreground">{stepLabel(step)}</span>
            {definition.entryStepId === step.id && <span className="text-[11px] text-muted">· Início</span>}
            {definition.mainMenuStepId === step.id && <span className="text-[11px] text-muted">· Menu principal</span>}
          </div>
          <Body definition={definition} step={step} />
        </li>
      ))}
    </ol>
  );
}
