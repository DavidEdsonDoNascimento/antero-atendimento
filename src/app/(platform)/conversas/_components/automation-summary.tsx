import { Badge } from "@/components/ui/badge";
import { automationEndReasonLabel, automationSessionStatusLabel } from "@/lib/labels";
import type { ConversationAutomation } from "@/modules/automations/sql-queries";

/** O que a automação fez nesta conversa e o que coletou — para quem assume o atendimento. */
export function AutomationSummary({ automation }: { automation: ConversationAutomation }) {
  const reason = automation.endReason ? (automationEndReasonLabel[automation.endReason] ?? automation.endReason) : null;
  return (
    <section aria-label="Dados coletados pela automação" className="space-y-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-2">
        <span className="font-medium text-sky-300">Automação</span>
        {automation.flowName && <span>{automation.flowName}</span>}
        {automation.version !== null && <span>(versão {automation.version})</span>}
        <Badge tone={automation.status === "active" ? "blue" : "zinc"}>{automationSessionStatusLabel[automation.status]}</Badge>
        {reason && <span>— {reason}</span>}
      </p>
      {automation.answers.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {automation.answers.map((answer) => (
            <div key={answer.key} className="contents">
              <dt className="text-muted-2">{answer.label}</dt>
              <dd className="break-words text-foreground">{answer.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted-2">Nenhum dado coletado.</p>
      )}
    </section>
  );
}
