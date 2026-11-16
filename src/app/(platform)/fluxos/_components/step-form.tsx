"use client";

import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import { navigationRowsOf } from "@/modules/automations/definition";
import {
  addOption,
  moveOption,
  removeOption,
  setQuestionLabel,
  STEP_TYPE_LABEL,
  STEP_TYPES,
  stepLabel,
  updateOption,
  updateStep,
  type EditorDefinition,
  type EditorIssue,
  type EditorMenuStep,
  type EditorStep,
  type StepType,
} from "@/modules/automations/editor";
import { WHATSAPP_LIMITS } from "@/modules/automations/limits";

import { CheckboxField, IssueText, issuesAt, selectClass, TextAreaField, TextField } from "./fields";
import { ImagePicker, type ImageOption } from "./image-picker";

export type StepFormContext = {
  definition: EditorDefinition;
  issues: EditorIssue[];
  images: ImageOption[];
  humanHandoffAvailable: boolean;
  /** Perguntas criadas desde a última gravação: a chave ainda acompanha o nome. */
  freshQuestions: ReadonlySet<string>;
  update: (change: (definition: EditorDefinition) => EditorDefinition) => void;
  select: (stepId: string) => void;
  /** Cria uma etapa logo depois de `afterId` e devolve o id (para ligar um destino a ela). */
  create: (type: StepType, afterId: string) => string;
  requestDelete: (stepId: string) => void;
};

const NEW_PREFIX = "__nova:";

/** Para onde a etapa (ou a opção) leva o cliente, escolhido pelo nome da etapa. */
export function DestinationSelect({
  ctx,
  from,
  label,
  value,
  onChange,
  issues,
  emptyLabel = "— Escolha a próxima etapa —",
  hint,
}: {
  ctx: StepFormContext;
  from: string;
  label: string;
  value: string;
  onChange: (stepId: string) => void;
  issues: EditorIssue[];
  emptyLabel?: string;
  hint?: string;
}) {
  const id = useId();
  const exists = value === "" || ctx.definition.steps.some((step) => step.id === value);
  const invalid = issues.some((issue) => issue.severity === "error");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <select
          id={id}
          value={value}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen.startsWith(NEW_PREFIX)) onChange(ctx.create(chosen.slice(NEW_PREFIX.length) as StepType, from));
            else onChange(chosen);
          }}
          className={cn(selectClass, invalid && "border-red-500/50")}
        >
          <option value="">{emptyLabel}</option>
          {!exists && <option value={value}>Etapa excluída</option>}
          <optgroup label="Etapas do fluxo">
            {ctx.definition.steps.map((step) => (
              <option key={step.id} value={step.id}>
                {stepLabel(step)} · {STEP_TYPE_LABEL[step.type]}
              </option>
            ))}
          </optgroup>
          <optgroup label="Criar etapa nova">
            {STEP_TYPES.map((type) => (
              <option key={type} value={`${NEW_PREFIX}${type}`}>
                + {STEP_TYPE_LABEL[type]}
              </option>
            ))}
          </optgroup>
        </select>
        {value !== "" && exists && (
          <Button type="button" variant="ghost" size="sm" onClick={() => ctx.select(value)} title="Abrir a etapa de destino">
            Abrir
          </Button>
        )}
      </div>
      {hint && <p className="text-xs text-muted-2">{hint}</p>}
      <IssueText issues={issues} />
    </div>
  );
}

function MenuOptions({ ctx, step }: { ctx: StepFormContext; step: EditorMenuStep }) {
  const nav = navigationRowsOf(
    { id: step.id, showBack: step.showBack ?? false, showMainMenu: step.showMainMenu ?? false },
    ctx.definition.mainMenuStepId,
  );
  const rows = step.options.length + Number(nav.back) + Number(nav.main);
  const full = rows >= WHATSAPP_LIMITS.listRows;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Opções</p>
        <span className={cn("text-xs tabular-nums", rows > WHATSAPP_LIMITS.listRows ? "text-red-300" : "text-muted-2")}>
          {rows} de {WHATSAPP_LIMITS.listRows} linhas
        </span>
      </div>
      <IssueText issues={issuesAt(ctx.issues, { stepId: step.id, field: "options" })} />
      <ol className="space-y-3">
        {step.options.map((option, index) => (
          <li key={option.id} className="space-y-3 rounded-md border border-line bg-surface-2/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">Opção {index + 1}</span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => ctx.update((definition) => moveOption(definition, step.id, option.id, -1))}
                  aria-label={`Mover a opção ${index + 1} para cima`}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === step.options.length - 1}
                  onClick={() => ctx.update((definition) => moveOption(definition, step.id, option.id, 1))}
                  aria-label={`Mover a opção ${index + 1} para baixo`}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => ctx.update((definition) => removeOption(definition, step.id, option.id))}
                  aria-label={`Excluir a opção ${index + 1}`}
                >
                  Excluir
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Título"
                value={option.title}
                max={WHATSAPP_LIMITS.listRowTitle}
                placeholder="Ex.: Fazer uma reserva"
                onChange={(title) => ctx.update((definition) => updateOption(definition, step.id, option.id, (current) => ({ ...current, title })))}
                issues={issuesAt(ctx.issues, { stepId: step.id, optionId: option.id, field: "title" })}
              />
              <TextField
                label="Descrição"
                optional
                value={option.description ?? ""}
                max={WHATSAPP_LIMITS.listRowDescription}
                onChange={(description) =>
                  ctx.update((definition) => updateOption(definition, step.id, option.id, (current) => ({ ...current, description })))
                }
                issues={issuesAt(ctx.issues, { stepId: step.id, optionId: option.id, field: "description" })}
              />
            </div>
            <DestinationSelect
              ctx={ctx}
              from={step.id}
              label="Ao escolher, ir para"
              value={option.next}
              emptyLabel="— Escolha para onde esta opção leva —"
              onChange={(next) => ctx.update((definition) => updateOption(definition, step.id, option.id, (current) => ({ ...current, next })))}
              issues={issuesAt(ctx.issues, { stepId: step.id, optionId: option.id, field: "next" })}
            />
          </li>
        ))}
      </ol>
      <div className="space-y-1">
        <Button type="button" variant="secondary" size="sm" disabled={full} onClick={() => ctx.update((definition) => addOption(definition, step.id))}>
          Adicionar opção
        </Button>
        {full && <p className="text-xs text-muted-2">O WhatsApp mostra no máximo {WHATSAPP_LIMITS.listRows} linhas por menu, contando “Voltar” e “Menu principal”.</p>}
      </div>
    </div>
  );
}

function change(ctx: StepFormContext, stepId: string, patch: Record<string, unknown>) {
  ctx.update((definition) => updateStep(definition, stepId, (step) => ({ ...step, ...patch }) as EditorStep));
}

export function StepForm({ ctx, step }: { ctx: StepFormContext; step: EditorStep }) {
  const at = (field: string) => issuesAt(ctx.issues, { stepId: step.id, field });
  const isEntry = ctx.definition.entryStepId === step.id;
  const set = (patch: Record<string, unknown>) => change(ctx, step.id, patch);
  const settings = ctx.definition.settings;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-gold-soft">{STEP_TYPE_LABEL[step.type]}</p>
          <h2 className="text-base font-semibold text-foreground">{stepLabel(step)}</h2>
          {isEntry && <p className="text-xs text-muted">É a primeira etapa: o cliente começa por aqui.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!isEntry && (
            <Button type="button" variant="ghost" size="sm" onClick={() => ctx.update((definition) => ({ ...definition, entryStepId: step.id }))}>
              Tornar primeira etapa
            </Button>
          )}
          <Button type="button" variant="danger" size="sm" onClick={() => ctx.requestDelete(step.id)}>
            Excluir etapa
          </Button>
        </div>
      </div>
      <IssueText issues={[...at("step"), ...at("reachability")]} />

      <TextField
        label="Nome da etapa"
        optional
        value={step.name ?? ""}
        max={60}
        onChange={(name) => set({ name })}
        placeholder="Ex.: Boas-vindas, Cardápio, Reservas"
        hint="Só para você se organizar; o cliente não vê."
        issues={at("name")}
      />

      {step.type === "message" && (
        <>
          <TextAreaField
            label="Mensagem"
            rows={5}
            value={step.text}
            max={WHATSAPP_LIMITS.textBody}
            onChange={(text) => set({ text })}
            placeholder="Olá! Seja bem-vindo. Como podemos ajudar?"
            issues={at("text")}
          />
          <DestinationSelect ctx={ctx} from={step.id} label="Depois desta mensagem, ir para" value={step.next} onChange={(next) => set({ next })} issues={at("next")} />
        </>
      )}

      {step.type === "image" && (
        <>
          <ImagePicker
            mediaId={step.mediaId || undefined}
            url={step.url}
            images={ctx.images}
            issues={[...at("image"), ...at("url"), ...at("mediaId")]}
            onPick={(source) => set("mediaId" in source ? { mediaId: source.mediaId, url: undefined } : { url: source.url, mediaId: undefined })}
          />
          <TextAreaField
            label="Legenda"
            optional
            value={step.caption ?? ""}
            max={WHATSAPP_LIMITS.imageCaption}
            onChange={(caption) => set({ caption })}
            placeholder="Ex.: Nossa programação da semana"
            issues={at("caption")}
          />
          <DestinationSelect ctx={ctx} from={step.id} label="Depois da imagem, ir para" value={step.next} onChange={(next) => set({ next })} issues={at("next")} />
        </>
      )}

      {step.type === "menu" && (
        <>
          <TextField label="Título do menu" optional value={step.header ?? ""} max={WHATSAPP_LIMITS.listHeader} onChange={(header) => set({ header })} issues={at("header")} />
          <TextAreaField
            label="Texto de apresentação"
            value={step.text}
            max={WHATSAPP_LIMITS.listBody}
            onChange={(text) => set({ text })}
            placeholder="Como podemos ajudar? Escolha uma opção."
            issues={at("text")}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Texto do botão"
              value={step.button ?? ""}
              max={WHATSAPP_LIMITS.listButton}
              onChange={(button) => set({ button })}
              hint="O botão que abre a lista no WhatsApp."
              issues={at("button")}
            />
            <TextField label="Rodapé" optional value={step.footer ?? ""} max={WHATSAPP_LIMITS.listFooter} onChange={(footer) => set({ footer })} issues={at("footer")} />
          </div>
          <MenuOptions ctx={ctx} step={step} />
          <div className="space-y-2 rounded-md border border-line p-3">
            <p className="text-sm font-medium text-foreground">Navegação</p>
            <CheckboxField
              label={`Mostrar a opção “${settings.backLabel}”`}
              checked={step.showBack ?? false}
              onChange={(showBack) => set({ showBack })}
              hint="Leva o cliente de volta ao menu anterior."
              issues={at("showBack")}
            />
            <CheckboxField
              label={`Mostrar a opção “${settings.mainMenuLabel}”`}
              checked={step.showMainMenu ?? false}
              onChange={(showMainMenu) => set({ showMainMenu })}
              hint={ctx.definition.mainMenuStepId === step.id ? "Este já é o menu principal: a opção não aparece nele." : "Leva o cliente ao menu principal do fluxo."}
              issues={at("showMainMenu")}
            />
          </div>
          <TextAreaField
            label="Mensagem para resposta que não é uma das opções"
            optional
            rows={2}
            value={step.invalidMessage ?? ""}
            max={WHATSAPP_LIMITS.textBody}
            onChange={(invalidMessage) => set({ invalidMessage })}
            placeholder={settings.invalidMessage}
            issues={at("invalidMessage")}
          />
        </>
      )}

      {step.type === "question" && (
        <>
          <TextAreaField
            label="Pergunta"
            value={step.text}
            max={WHATSAPP_LIMITS.textBody}
            onChange={(text) => set({ text })}
            placeholder="Qual é o seu nome completo?"
            issues={at("text")}
          />
          <TextField
            label="Nome da informação coletada"
            value={step.label}
            max={60}
            placeholder="Ex.: Nome, Quantidade de pessoas, Data desejada"
            hint="É assim que a equipe vê a resposta do cliente na conversa."
            onChange={(label) => ctx.update((definition) => setQuestionLabel(definition, step.id, label, ctx.freshQuestions.has(step.id)))}
            issues={at("label")}
          />
          <DestinationSelect ctx={ctx} from={step.id} label="Depois da resposta, ir para" value={step.next} onChange={(next) => set({ next })} issues={at("next")} />
          <TextAreaField
            label="Mensagem para resposta inválida"
            optional
            rows={2}
            value={step.invalidMessage ?? ""}
            max={WHATSAPP_LIMITS.textBody}
            onChange={(invalidMessage) => set({ invalidMessage })}
            placeholder={settings.invalidMessage}
            hint="Usada quando a resposta fica vazia ou passa do tamanho máximo."
            issues={at("invalidMessage")}
          />
        </>
      )}

      {step.type === "handoff" && (
        <>
          <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-sky-100">
            A automação para aqui e a conversa vai para a Inbox, aguardando alguém da equipe assumir. As respostas
            coletadas aparecem para quem atender.
          </div>
          {!ctx.humanHandoffAvailable && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">
              Sua organização não tem o módulo Atendimento. Ao chegar aqui, o cliente recebe a mensagem de
              indisponibilidade abaixo e {step.unavailableNext ? "segue para a etapa escolhida" : "a automação termina"}.
            </div>
          )}
          <TextAreaField
            label="Mensagem ao encaminhar"
            optional
            rows={2}
            value={step.text ?? ""}
            max={WHATSAPP_LIMITS.textBody}
            onChange={(text) => set({ text })}
            placeholder={settings.handoffMessage}
            issues={at("text")}
          />
          <TextAreaField
            label="Mensagem quando não há atendimento humano"
            optional
            rows={2}
            value={step.unavailableText ?? ""}
            max={WHATSAPP_LIMITS.textBody}
            onChange={(unavailableText) => set({ unavailableText })}
            placeholder={settings.handoffUnavailableMessage}
            issues={at("unavailableText")}
          />
          <DestinationSelect
            ctx={ctx}
            from={step.id}
            label="Sem atendimento humano, ir para"
            value={step.unavailableNext ?? ""}
            emptyLabel="Encerrar a automação"
            onChange={(unavailableNext) => set({ unavailableNext })}
            issues={at("unavailableNext")}
          />
        </>
      )}

      {step.type === "end" && (
        <>
          <TextAreaField
            label="Mensagem final"
            optional
            rows={3}
            value={step.text ?? ""}
            max={WHATSAPP_LIMITS.textBody}
            onChange={(text) => set({ text })}
            placeholder="Obrigado pelo contato! Ficamos à disposição."
            issues={at("text")}
          />
          <p className="text-xs text-muted-2">A automação termina aqui e a conversa é marcada como resolvida.</p>
        </>
      )}
    </div>
  );
}
