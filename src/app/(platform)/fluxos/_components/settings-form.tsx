"use client";

import { useId, useState } from "react";

import { Label } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import { STEP_TYPE_LABEL, stepLabel, type EditorDefinition, type EditorIssue } from "@/modules/automations/editor";
import { WHATSAPP_LIMITS } from "@/modules/automations/limits";

import { CheckboxField, IssueText, issuesAt, selectClass, TextAreaField, TextField } from "./fields";

type Settings = EditorDefinition["settings"];
type KeywordField = "humanKeywords" | "mainMenuKeywords" | "backKeywords";

/** Palavras separadas por vírgula; o texto digitado fica como está até sair do campo. */
function KeywordsField({
  label,
  hint,
  value,
  onChange,
  issues,
}: {
  label: string;
  hint: string;
  value: string[];
  onChange: (value: string[]) => void;
  issues: EditorIssue[];
}) {
  const [text, setText] = useState(value.join(", "));
  return (
    <TextField
      label={label}
      value={text}
      hint={hint}
      onChange={(next) => {
        setText(next);
        onChange(next.split(",").map((word) => word.trim()).filter(Boolean));
      }}
      issues={issues}
    />
  );
}

export function SettingsForm({
  definition,
  issues,
  isEntry,
  otherEntryFlowName,
  humanHandoffAvailable,
  onEntryChange,
  update,
}: {
  definition: EditorDefinition;
  issues: EditorIssue[];
  isEntry: boolean;
  otherEntryFlowName: string | null;
  humanHandoffAvailable: boolean;
  onEntryChange: (isEntry: boolean) => void;
  update: (change: (definition: EditorDefinition) => EditorDefinition) => void;
}) {
  const entryId = useId();
  const mainId = useId();
  const attemptsId = useId();
  const settings = definition.settings;
  const at = (field: string) => issuesAt(issues, { field });
  const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    update((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));
  const keywordIssues = (field: KeywordField) => issues.filter((issue) => issue.stepId === undefined && issue.field === `settings.${field}`);
  const menus = definition.steps.filter((step) => step.type === "menu");
  const entryExists = definition.steps.some((step) => step.id === definition.entryStepId);
  const mainExists = !definition.mainMenuStepId || menus.some((step) => step.id === definition.mainMenuStepId);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-gold-soft">Configurações gerais</p>
        <h2 className="text-base font-semibold text-foreground">Como a automação começa e como o cliente navega</h2>
      </div>

      <CheckboxField
        label="Responder automaticamente às conversas novas"
        checked={isEntry}
        disabled={!isEntry && otherEntryFlowName !== null}
        onChange={onEntryChange}
        hint={
          !isEntry && otherEntryFlowName !== null
            ? `“${otherEntryFlowName}” já responde às conversas novas. Só uma automação por vez pode fazer isso.`
            : "Quando um cliente escreve pela primeira vez (ou volta depois de um atendimento resolvido), esta automação responde."
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={entryId}>Primeira etapa</Label>
          <select
            id={entryId}
            value={definition.entryStepId}
            onChange={(event) => update((current) => ({ ...current, entryStepId: event.target.value }))}
            className={cn(selectClass, at("entryStepId").length > 0 && "border-red-500/50")}
          >
            <option value="">— Escolha a primeira etapa —</option>
            {!entryExists && definition.entryStepId && <option value={definition.entryStepId}>Etapa excluída</option>}
            {definition.steps.map((step) => (
              <option key={step.id} value={step.id}>
                {stepLabel(step)} · {STEP_TYPE_LABEL[step.type]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-2">O que o cliente recebe ao escrever pela primeira vez.</p>
          <IssueText issues={at("entryStepId")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={mainId}>Menu principal</Label>
          <select
            id={mainId}
            value={definition.mainMenuStepId ?? ""}
            onChange={(event) => update((current) => ({ ...current, mainMenuStepId: event.target.value || undefined }))}
            className={cn(selectClass, at("mainMenuStepId").length > 0 && "border-red-500/50")}
          >
            <option value="">Nenhum</option>
            {!mainExists && <option value={definition.mainMenuStepId}>Etapa excluída</option>}
            {menus.map((step) => (
              <option key={step.id} value={step.id}>
                {stepLabel(step)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-2">Para onde vão a opção “{settings.mainMenuLabel}” e a palavra “menu”.</p>
          <IssueText issues={at("mainMenuStepId")} />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-line p-4">
        <p className="text-sm font-medium text-foreground">Atalhos que o cliente pode escrever a qualquer momento</p>
        <KeywordsField
          label="Falar com atendente"
          value={settings.humanKeywords}
          onChange={(value) => setSetting("humanKeywords", value)}
          hint={
            humanHandoffAvailable
              ? "Palavras separadas por vírgula. Encaminham a conversa para a equipe."
              : "Palavras separadas por vírgula. Sem o módulo Atendimento, o cliente recebe a mensagem de indisponibilidade."
          }
          issues={keywordIssues("humanKeywords")}
        />
        <KeywordsField
          label="Voltar ao menu principal"
          value={settings.mainMenuKeywords}
          onChange={(value) => setSetting("mainMenuKeywords", value)}
          hint="Palavras separadas por vírgula. Só funcionam com um menu principal escolhido."
          issues={keywordIssues("mainMenuKeywords")}
        />
        <KeywordsField
          label="Voltar ao menu anterior"
          value={settings.backKeywords}
          onChange={(value) => setSetting("backKeywords", value)}
          hint="Palavras separadas por vírgula."
          issues={keywordIssues("backKeywords")}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Nome da opção de voltar"
            value={settings.backLabel}
            max={WHATSAPP_LIMITS.listRowTitle}
            onChange={(value) => setSetting("backLabel", value)}
            issues={at("settings.backLabel")}
          />
          <TextField
            label="Nome da opção de menu principal"
            value={settings.mainMenuLabel}
            max={WHATSAPP_LIMITS.listRowTitle}
            onChange={(value) => setSetting("mainMenuLabel", value)}
            issues={at("settings.mainMenuLabel")}
          />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-line p-4">
        <p className="text-sm font-medium text-foreground">Mensagens padrão</p>
        <TextAreaField
          label="Quando a resposta não é uma opção válida"
          rows={2}
          value={settings.invalidMessage}
          max={WHATSAPP_LIMITS.textBody}
          onChange={(value) => setSetting("invalidMessage", value)}
          issues={at("settings.invalidMessage")}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={attemptsId}>Respostas inválidas seguidas antes de chamar a equipe</Label>
          <select
            id={attemptsId}
            value={settings.maxInvalidAttempts}
            onChange={(event) => setSetting("maxInvalidAttempts", Number(event.target.value))}
            className={cn(selectClass, "sm:max-w-40")}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <TextAreaField
          label="Ao encaminhar para a equipe"
          rows={2}
          value={settings.handoffMessage}
          max={WHATSAPP_LIMITS.textBody}
          onChange={(value) => setSetting("handoffMessage", value)}
          issues={at("settings.handoffMessage")}
        />
        <TextAreaField
          label="Quando não há atendimento humano"
          rows={2}
          value={settings.handoffUnavailableMessage}
          max={WHATSAPP_LIMITS.textBody}
          onChange={(value) => setSetting("handoffUnavailableMessage", value)}
          issues={at("settings.handoffUnavailableMessage")}
        />
      </div>
    </div>
  );
}
