"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { automationFlowStatusLabel, automationFlowStatusTone } from "@/lib/labels";
import type { AutomationFlowStatus } from "@/lib/types/database";
import { cn } from "@/lib/utils/cn";
import {
  cleanDefinition,
  describeReference,
  editorIssues,
  flowOutline,
  hasBlockingIssues,
  insertStep,
  moveStep,
  newStep,
  referencesTo,
  removeStep,
  STEP_TYPE_LABEL,
  STEP_TYPES,
  stepLabel,
  type EditorDefinition,
  type StepType,
} from "@/modules/automations/editor";
import {
  publishFlowAction,
  saveDraftAction,
  type PublishState,
  type SaveDraftState,
} from "@/modules/automations/editor-actions";

import { Dialog } from "./dialog";
import { FlowPreview } from "./flow-preview";
import { FlowStatusForm } from "./flow-status-form";
import type { ImageOption } from "./image-picker";
import { SettingsForm } from "./settings-form";
import { StepForm, type StepFormContext } from "./step-form";

export type EditorFlow = {
  id: string;
  name: string;
  status: AutomationFlowStatus;
  isEntry: boolean;
  otherEntryFlowName: string | null;
  draftRevision: number;
  publishedVersion: number | null;
  hasDraftChanges: boolean;
};

const STEP_HINT: Record<StepType, string> = {
  message: "Um texto enviado ao cliente.",
  image: "Uma foto com legenda: cardápio, programação, local.",
  menu: "Opções para o cliente escolher.",
  question: "Pergunta cuja resposta fica guardada para a equipe.",
  handoff: "Passa a conversa para alguém da equipe.",
  end: "Encerra a automação, com uma mensagem final opcional.",
};

const PUBLISH_INITIAL: PublishState = { status: "idle" };

function snapshotOf(name: string, isEntry: boolean, definition: EditorDefinition): string {
  return JSON.stringify({ name, isEntry, definition: cleanDefinition(definition) });
}

export function FlowEditor({
  flow,
  initialDefinition,
  images,
  humanHandoffAvailable,
  restoredVersion,
}: {
  flow: EditorFlow;
  initialDefinition: EditorDefinition;
  images: ImageOption[];
  humanHandoffAvailable: boolean;
  restoredVersion: number | null;
}) {
  const router = useRouter();
  const [definition, setDefinition] = useState(initialDefinition);
  const [name, setName] = useState(flow.name);
  const [isEntry, setIsEntry] = useState(flow.isEntry);
  const [selected, setSelected] = useState<string>(initialDefinition.entryStepId || "settings");
  const [adding, setAdding] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  const allowLeave = useRef(false);

  const [saveState, saveAction, saving] = useActionState(saveDraftAction, {
    status: "idle",
    revision: flow.draftRevision,
    snapshot: snapshotOf(flow.name, flow.isEntry, initialDefinition),
  } satisfies SaveDraftState);
  const [publishState, publishAction, publishPending] = useActionState(publishFlowAction, PUBLISH_INITIAL);

  const snapshot = snapshotOf(name, isEntry, definition);
  const dirty = snapshot !== saveState.snapshot;
  const issues = editorIssues(definition);
  const errors = issues.filter((issue) => issue.severity === "error");
  const blocked = hasBlockingIssues(issues);
  const conflict = saveState.status === "conflict" || publishState.status === "conflict";
  // Vem do servidor, relido a cada gravação ou publicação (revalidatePath nas ações).
  const unpublished = flow.hasDraftChanges;
  // A chave da informação coletada só acompanha o nome enquanto a pergunta não foi gravada.
  const savedQuestions = new Set(
    (JSON.parse(saveState.snapshot) as { definition: EditorDefinition }).definition.steps
      .filter((step) => step.type === "question")
      .map((step) => step.id),
  );
  const freshQuestions = new Set(definition.steps.filter((step) => step.type === "question" && !savedQuestions.has(step.id)).map((step) => step.id));
  const canPublish = !dirty && !blocked && !conflict && unpublished && name.trim() !== "";
  const outline = flowOutline(definition);

  // Sair com alterações não salvas: aviso do navegador e confirmação nos links da aplicação.
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (allowLeave.current) return;
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (allowLeave.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setLeavingTo(url.pathname + url.search);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  function create(type: StepType, afterId?: string): string {
    const step = newStep(definition, type);
    setDefinition((current) => insertStep(current, step, afterId));
    return step.id;
  }

  const ctx: StepFormContext = {
    definition,
    issues,
    images,
    humanHandoffAvailable,
    freshQuestions,
    update: (change) => setDefinition((current) => change(current)),
    select: setSelected,
    create: (type, afterId) => create(type, afterId),
    requestDelete: setDeleting,
  };

  const selectedStep = definition.steps.find((step) => step.id === selected);
  const errorCount = (stepId: string) => errors.filter((issue) => issue.stepId === stepId).length;
  const settingsErrors = errors.filter((issue) => issue.stepId === undefined).length;
  const deletingStep = deleting ? definition.steps.find((step) => step.id === deleting) : undefined;
  const deletingReferences = deleting ? referencesTo(definition, deleting) : [];

  function reload() {
    allowLeave.current = true;
    window.location.reload();
  }

  return (
    <div className="space-y-4">
      {/* Cabeçalho: nome, estado e ações */}
      <div className="space-y-3">
        <Link href="/fluxos" className="text-xs text-muted hover:text-foreground">
          ← Automações
        </Link>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor="flow-name" className="sr-only">
              Nome da automação
            </label>
            <input
              id="flow-name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xl font-semibold tracking-tight text-foreground outline-none hover:border-line focus-visible:border-gold/50"
            />
            {name.trim() === "" && <p className="text-xs text-red-300">Dê um nome para a automação.</p>}
            <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted">
              <Badge tone={automationFlowStatusTone[flow.status]}>{automationFlowStatusLabel[flow.status]}</Badge>
              <span>{flow.publishedVersion ? `Versão publicada: ${flow.publishedVersion}` : "Ainda não publicada"}</span>
              {isEntry && <Badge tone="gold">Responde às conversas novas</Badge>}
              {dirty ? (
                <Badge tone="amber">Alterações não salvas</Badge>
              ) : unpublished ? (
                <Badge tone="blue">Rascunho salvo, não publicado</Badge>
              ) : (
                <Badge tone="zinc">Igual à versão publicada</Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <form action={saveAction}>
              <input type="hidden" name="flowId" value={flow.id} />
              <input type="hidden" name="expectedRevision" value={saveState.revision} />
              <input type="hidden" name="snapshot" value={snapshot} />
              <button
                type="submit"
                disabled={saving || !dirty || conflict || name.trim() === ""}
                aria-busy={saving}
                className={buttonVariants({ variant: "secondary" })}
              >
                {saving ? "Salvando…" : "Salvar rascunho"}
              </button>
            </form>
            <Button type="button" variant="secondary" onClick={() => setPreviewOpen(!previewOpen)} aria-pressed={previewOpen}>
              {previewOpen ? "Fechar teste" : "Testar conversa"}
            </Button>
            <Button type="button" disabled={!canPublish || publishPending} aria-busy={publishPending} onClick={() => setPublishing(true)}>
              {publishPending ? "Publicando…" : "Publicar"}
            </Button>
            <FlowStatusForm flowId={flow.id} status={flow.status} />
            <Link href={`/fluxos/${flow.id}/versoes`} className={buttonVariants({ variant: "ghost" })}>
              Histórico de versões
            </Link>
          </div>
        </div>

        <div className="space-y-2" aria-live="polite">
          {restoredVersion !== null && saveState.status === "idle" && (
            <p className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm text-sky-100">
              O conteúdo da versão {restoredVersion} foi carregado como rascunho. Revise, teste e publique para que ele
              volte a funcionar — até lá, continua valendo a versão publicada.
            </p>
          )}
          {conflict && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-200">
              <span>
                Outra pessoa salvou alterações nesta automação depois que você a abriu. Suas alterações não foram
                gravadas. Recarregue para ver a versão mais recente (o que você mudou aqui será descartado).
              </span>
              <Button type="button" variant="secondary" size="sm" onClick={reload}>
                Recarregar
              </Button>
            </div>
          )}
          {/* Cada confirmação some quando deixa de ser verdade (salvo → publicado → alterado de novo). */}
          {saveState.status === "saved" && !dirty && unpublished && <p role="status" className="text-sm text-emerald-300">{saveState.message}</p>}
          {saveState.status === "error" && <p role="alert" className="text-sm text-red-300">{saveState.message}</p>}
          {publishState.status === "published" && !dirty && !unpublished && <p role="status" className="text-sm text-emerald-300">{publishState.message}</p>}
          {publishState.status === "error" && <p role="alert" className="text-sm text-red-300">{publishState.message}</p>}
          {!canPublish && !conflict && (
            <p className="text-xs text-muted-2">
              {blocked
                ? `${errors.length} ${errors.length === 1 ? "problema impede" : "problemas impedem"} a publicação — veja os itens marcados em vermelho.`
                : dirty
                  ? "Salve o rascunho para poder publicar."
                  : !unpublished
                    ? "Nada novo para publicar: o rascunho é igual à versão publicada."
                    : null}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        {/* Etapas */}
        <nav aria-label="Etapas do fluxo" className="space-y-2">
          <button
            type="button"
            onClick={() => setSelected("settings")}
            aria-current={selected === "settings" ? "true" : undefined}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
              selected === "settings" ? "border-gold/40 bg-gold/5 text-foreground" : "border-line text-muted hover:text-foreground",
            )}
          >
            <span>Configurações gerais</span>
            {settingsErrors > 0 && <span className="rounded-full bg-red-500/20 px-1.5 text-xs text-red-200">{settingsErrors}</span>}
          </button>
          <ol className="space-y-1.5">
            {definition.steps.map((step, index) => (
              <li key={step.id} className="flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => setSelected(step.id)}
                  aria-current={selected === step.id ? "true" : undefined}
                  className={cn(
                    "min-w-0 flex-1 rounded-md border px-3 py-2 text-left transition-colors",
                    selected === step.id ? "border-gold/40 bg-gold/5" : "border-line hover:border-line-strong",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-muted-2">{STEP_TYPE_LABEL[step.type]}</span>
                    {errorCount(step.id) > 0 && (
                      <span className="rounded-full bg-red-500/20 px-1.5 text-xs text-red-200" aria-label={`${errorCount(step.id)} problema(s)`}>
                        {errorCount(step.id)}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-sm text-foreground">{stepLabel(step)}</span>
                  {(definition.entryStepId === step.id || definition.mainMenuStepId === step.id) && (
                    <span className="mt-0.5 block text-[11px] text-gold-soft">
                      {[definition.entryStepId === step.id && "Início", definition.mainMenuStepId === step.id && "Menu principal"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </button>
                <span className="flex flex-col">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => setDefinition((current) => moveStep(current, step.id, -1))}
                    aria-label={`Mover “${stepLabel(step)}” para cima`}
                    className="flex-1 rounded px-1 text-xs text-muted-2 hover:text-foreground disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === definition.steps.length - 1}
                    onClick={() => setDefinition((current) => moveStep(current, step.id, 1))}
                    aria-label={`Mover “${stepLabel(step)}” para baixo`}
                    className="flex-1 rounded px-1 text-xs text-muted-2 hover:text-foreground disabled:opacity-30"
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
          {adding ? (
            <div className="space-y-1 rounded-md border border-line p-2">
              <p className="px-1 text-xs font-medium text-muted">Adicionar etapa</p>
              {STEP_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    const id = create(type, selectedStep?.id);
                    setSelected(id);
                    setAdding(false);
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="block text-sm text-foreground">{STEP_TYPE_LABEL[type]}</span>
                  <span className="block text-xs text-muted-2">{STEP_HINT[type]}</span>
                </button>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button type="button" variant="secondary" size="sm" className="w-full" onClick={() => setAdding(true)}>
              + Adicionar etapa
            </Button>
          )}
        </nav>

        {/* Etapa escolhida */}
        <section className="min-w-0 rounded-lg border border-line bg-surface p-5">
          {selectedStep ? (
            <StepForm key={selectedStep.id} ctx={ctx} step={selectedStep} />
          ) : (
            <SettingsForm
              definition={definition}
              issues={issues}
              isEntry={isEntry}
              otherEntryFlowName={flow.otherEntryFlowName}
              humanHandoffAvailable={humanHandoffAvailable}
              onEntryChange={setIsEntry}
              update={ctx.update}
            />
          )}
        </section>

        {/* Painel ao lado, por cima da página: o formulário continua editável e a prévia acompanha. */}
        {previewOpen && (
          <div className="fixed inset-x-0 bottom-0 top-16 z-40 flex flex-col p-3 sm:left-auto sm:w-[24rem]">
            <FlowPreview definition={definition} humanHandoffAvailable={humanHandoffAvailable} onClose={() => setPreviewOpen(false)} />
          </div>
        )}
      </div>

      {/* Excluir etapa */}
      <Dialog open={deletingStep !== undefined} onClose={() => setDeleting(null)} title="Excluir etapa?">
        {deletingStep && (
          <>
            <p className="text-sm text-muted">
              “{stepLabel(deletingStep)}” será excluída do rascunho.
            </p>
            {deletingReferences.length > 0 ? (
              <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">
                <p>Esta etapa é usada em:</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {deletingReferences.map((reference, index) => (
                    <li key={index}>{describeReference(definition, reference)}</li>
                  ))}
                </ul>
                <p>Esses caminhos ficarão marcados em vermelho até você escolher outro destino. Não dá para publicar antes disso.</p>
              </div>
            ) : (
              <p className="text-sm text-muted">Nenhuma outra parte do fluxo leva até ela.</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
                Cancelar
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setDefinition((current) => removeStep(current, deletingStep.id));
                  setSelected("settings");
                  setDeleting(null);
                }}
              >
                Excluir etapa
              </Button>
            </div>
          </>
        )}
      </Dialog>

      {/* Publicar */}
      <Dialog open={publishing} onClose={() => setPublishing(false)} title={`Publicar a versão ${(flow.publishedVersion ?? 0) + 1}?`}>
        <div className="space-y-2 text-sm text-muted">
          <p>
            <span className="text-foreground">{name}</span>: {outline.steps} etapas — {outline.message + outline.image} mensagens e
            imagens, {outline.menu} menus, {outline.question} perguntas, {outline.handoff} encaminhamentos e {outline.end}{" "}
            conclusões.
          </p>
          <p>
            A partir de agora, as <strong className="text-foreground">novas conversas</strong> usam esta versão. Conversas
            que já estão em andamento continuam na versão em que começaram.
          </p>
          {isEntry && flow.status !== "paused" && <p>Esta automação responde às conversas novas da sua organização.</p>}
          {flow.status === "paused" && <p>A automação está pausada: a versão fica pronta, mas só responde depois de reativada.</p>}
          {issues.length > errors.length && (
            <p className="text-amber-200">Há {issues.length - errors.length} aviso(s) que não impedem a publicação.</p>
          )}
        </div>
        <form
          action={publishAction}
          onSubmit={() => setPublishing(false)}
          className="flex justify-end gap-2"
        >
          <input type="hidden" name="flowId" value={flow.id} />
          <input type="hidden" name="expectedRevision" value={saveState.revision} />
          <Button type="button" variant="ghost" onClick={() => setPublishing(false)}>
            Cancelar
          </Button>
          <button type="submit" disabled={publishPending || !canPublish} className={buttonVariants({})}>
            {publishPending ? "Publicando…" : "Publicar versão"}
          </button>
        </form>
      </Dialog>

      {/* Sair sem salvar */}
      <Dialog open={leavingTo !== null} onClose={() => setLeavingTo(null)} title="Sair sem salvar?">
        <p className="text-sm text-muted">Você tem alterações que ainda não foram salvas. Se sair agora, elas serão perdidas.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setLeavingTo(null)}>
            Continuar editando
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              allowLeave.current = true;
              if (leavingTo) router.push(leavingTo);
              setLeavingTo(null);
            }}
          >
            Sair sem salvar
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
