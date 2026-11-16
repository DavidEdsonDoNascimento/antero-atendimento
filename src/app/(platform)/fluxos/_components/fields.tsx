"use client";

import { useId, type ReactNode } from "react";

import { Label } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import type { EditorIssue } from "@/modules/automations/editor";

/** Problemas de um campo da tela (erro ou aviso). */
export function issuesAt(issues: EditorIssue[], at: { stepId?: string; optionId?: string; field: string }): EditorIssue[] {
  return issues.filter(
    (issue) => issue.stepId === at.stepId && issue.optionId === at.optionId && issue.field === at.field,
  );
}

const controlClass = cn(
  "w-full rounded-md border bg-surface-2 px-3 py-2 text-sm text-foreground",
  "placeholder:text-muted-2 outline-none transition-colors",
  "focus-visible:border-gold/50 focus-visible:ring-2 focus-visible:ring-gold/30",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

export function IssueText({ issues, id }: { issues: EditorIssue[]; id?: string }) {
  if (issues.length === 0) return null;
  return (
    <div id={id} className="space-y-0.5">
      {issues.map((issue) => (
        <p key={issue.message} className={cn("text-xs", issue.severity === "error" ? "text-red-300" : "text-amber-300")}>
          {issue.message}
        </p>
      ))}
    </div>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  issues?: EditorIssue[];
  /** Limite do WhatsApp: mostra o contador. */
  max?: number;
  hint?: ReactNode;
  placeholder?: string;
  optional?: boolean;
};

function FieldFrame({
  id,
  label,
  optional,
  value,
  max,
  hint,
  issues,
  children,
}: Omit<FieldProps, "onChange" | "placeholder"> & { id: string; children: ReactNode }) {
  const length = value.trim().length;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {optional && <span className="ml-1 text-xs font-normal text-muted-2">(opcional)</span>}
        </Label>
        {max !== undefined && (
          <span className={cn("text-xs tabular-nums", length > max ? "text-red-300" : "text-muted-2")} aria-hidden>
            {length}/{max}
          </span>
        )}
      </div>
      {children}
      {hint && <p className="text-xs text-muted-2">{hint}</p>}
      <IssueText issues={issues ?? []} id={`${id}-issues`} />
    </div>
  );
}

export function TextField(props: FieldProps) {
  const id = useId();
  const invalid = props.issues?.some((issue) => issue.severity === "error") ?? false;
  return (
    <FieldFrame id={id} {...props}>
      <input
        id={id}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={props.issues?.length ? `${id}-issues` : undefined}
        className={cn(controlClass, invalid ? "border-red-500/50" : "border-line")}
      />
    </FieldFrame>
  );
}

export function TextAreaField(props: FieldProps & { rows?: number }) {
  const id = useId();
  const invalid = props.issues?.some((issue) => issue.severity === "error") ?? false;
  return (
    <FieldFrame id={id} {...props}>
      <textarea
        id={id}
        rows={props.rows ?? 3}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={props.issues?.length ? `${id}-issues` : undefined}
        className={cn(controlClass, "resize-y", invalid ? "border-red-500/50" : "border-line")}
      />
    </FieldFrame>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  disabled,
  issues,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
  issues?: EditorIssue[];
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={cn("flex items-start gap-2 text-sm text-foreground", disabled && "opacity-60")}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-4 accent-[var(--color-gold)]"
        />
        <span>{label}</span>
      </label>
      {hint && <p className="pl-6 text-xs text-muted-2">{hint}</p>}
      <div className="pl-6">
        <IssueText issues={issues ?? []} />
      </div>
    </div>
  );
}

export const selectClass = cn(controlClass, "border-line pr-8");
