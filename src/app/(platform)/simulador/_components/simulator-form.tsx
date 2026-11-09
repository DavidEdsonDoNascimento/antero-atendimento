"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { automationFlowStatusLabel, automationFlowStatusTone, conversationStatusLabel, conversationStatusTone } from "@/lib/labels";
import { cn } from "@/lib/utils/cn";
import type { OutboundAction } from "@/modules/automations/actions";
import type { FlowSummary } from "@/modules/automations/sql-queries";
import {
  installDemoFlowAction,
  simulateInboundAction,
  type DemoFlowActionState,
  type SimulatorActionState,
} from "@/modules/simulator/actions";
import type { SimulatorChannel, SimulatorContact } from "@/modules/simulator/sql-queries";

const INITIAL_STATE: SimulatorActionState = { status: "idle" };
const DEMO_INITIAL_STATE: DemoFlowActionState = { status: "idle" };

/** Automações na organização do canal: `null` enquanto não há canal. */
export type SimulatorAutomation = { enabled: boolean; flow: FlowSummary | null } | null;

/** Como o cliente veria cada resposta da automação; as linhas do menu viram atalhos de resposta. */
function Reply({ action, onPick }: { action: OutboundAction; onPick: (text: string) => void }) {
  if (action.type === "text") return <p className="whitespace-pre-wrap">{action.text}</p>;
  if (action.type === "image") {
    return (
      <p className="whitespace-pre-wrap">
        <span className="mr-1 rounded border border-sky-500/30 px-1 text-[11px] text-sky-300">imagem</span>
        {action.caption ?? action.url}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {action.header && <p className="font-medium">{action.header}</p>}
      <p className="whitespace-pre-wrap">{action.body}</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={action.button}>
        {action.sections.flatMap((section) => section.rows).map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onPick(row.title)}
            title={row.description}
            className="rounded-full border border-line px-2.5 py-1 text-xs text-foreground hover:border-gold/40"
          >
            {row.title}
          </button>
        ))}
      </div>
    </div>
  );
}

function AutomationCard({ channel, automation }: { channel: SimulatorChannel; automation: SimulatorAutomation }) {
  const [state, formAction, pending] = useActionState(installDemoFlowAction, DEMO_INITIAL_STATE);
  if (!automation) return null;
  return (
    <Card className="space-y-3 p-5">
      <p className="text-sm font-medium text-foreground">Automação (dev)</p>
      {!automation.enabled ? (
        <p className="text-xs text-muted">Módulo Automações desabilitado nesta organização: as mensagens vão direto para a Inbox.</p>
      ) : automation.flow ? (
        <div className="space-y-1 text-xs text-muted">
          <p className="text-sm text-foreground">{automation.flow.name}</p>
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge tone={automationFlowStatusTone[automation.flow.status]}>{automationFlowStatusLabel[automation.flow.status]}</Badge>
            <span>versão {automation.flow.publishedVersion ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{automation.flow.activeSessions} sessão(ões) em andamento</span>
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted">Sem fluxo de entrada: as mensagens vão direto para a Inbox.</p>
      )}
      {automation.enabled && (
        <form action={formAction}>
          <input type="hidden" name="channelId" value={channel.id} />
          <button type="submit" disabled={pending} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            {pending ? "Publicando…" : automation.flow ? "Publicar de novo o fluxo demonstrativo" : "Instalar fluxo demonstrativo"}
          </button>
        </form>
      )}
      {state.status !== "idle" && (
        <p role={state.status === "error" ? "alert" : "status"} className={cn("text-xs", state.status === "error" ? "text-red-300" : "text-emerald-300")}>
          {state.message}
        </p>
      )}
    </Card>
  );
}

const textareaClass = cn(
  "w-full resize-y rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-foreground",
  "placeholder:text-muted-2 outline-none transition-colors",
  "focus-visible:border-gold/50 focus-visible:ring-2 focus-visible:ring-gold/30",
);

function channelLabel(channel: SimulatorChannel): string {
  return `${channel.organization_name} — ${channel.display_name || channel.phone_number || "Canal sem nome"}`;
}

export function SimulatorForm({
  channels,
  selected,
  contacts,
  activeOrganizationId,
  automation,
}: {
  channels: SimulatorChannel[];
  selected: SimulatorChannel;
  contacts: SimulatorContact[];
  activeOrganizationId: string;
  automation: SimulatorAutomation;
}) {
  const [state, formAction, pending] = useActionState(simulateInboundAction, INITIAL_STATE);
  const [phone, setPhone] = useState(contacts[0]?.phone_number ?? "");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const inActiveOrganization = selected.organization_id === activeOrganizationId;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card className="space-y-4 p-5">
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Canal de desenvolvimento</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Canais">
            {channels.map((channel) => (
              <Link
                key={channel.id}
                href={`/simulador?canal=${channel.id}`}
                aria-current={channel.id === selected.id ? "true" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  channel.id === selected.id
                    ? "border-gold/40 bg-gold/10 text-gold-soft"
                    : "border-line text-muted hover:border-line-strong hover:text-foreground",
                )}
              >
                {channelLabel(channel)}
              </Link>
            ))}
          </div>
          {!inActiveOrganization && (
            <p className="text-xs text-amber-300">
              Este canal é de outra organização sua. A Inbox mostra só a organização ativa.
            </p>
          )}
        </div>

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="channelId" value={selected.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Telefone do cliente (E.164)" htmlFor="sim-phone">
              <Input
                id="sim-phone"
                name="phoneNumber"
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+55 11 91234-5678"
                autoComplete="off"
              />
            </Field>
            <Field label="Nome (só para contato novo)" htmlFor="sim-name">
              <Input
                id="sim-name"
                name="contactName"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Cliente fictício"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label="Mensagem do cliente" htmlFor="sim-content">
            <textarea
              id="sim-content"
              name="content"
              required
              rows={3}
              maxLength={4096}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Olá, gostaria de atendimento."
              className={textareaClass}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={pending} aria-busy={pending} className={buttonVariants({ size: "sm" })}>
              {pending ? "Enviando…" : "Enviar como cliente"}
            </button>
            <span className="text-xs text-muted-2">Gravado pela mesma ingestão que receberá a Cloud API.</span>
          </div>
        </form>

        <div aria-live="polite" className="space-y-2">
          {state.status === "error" && (
            <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {state.message}
            </p>
          )}
          {state.status === "success" && (
            <div
              role="status"
              className="space-y-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
            >
              <p>{state.message}</p>
              {state.automation && <p className="text-xs text-sky-300">{state.automation}</p>}
              <div className="flex flex-wrap gap-2">
                {state.channelId && inActiveOrganization && (
                  <Link
                    href={`/conversas/${state.conversationId}`}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    Abrir na Inbox
                  </Link>
                )}
                {/* Reentrega: mesmo id externo, como a Meta faz quando não recebe confirmação. */}
                <form action={formAction}>
                  <input type="hidden" name="channelId" value={state.channelId} />
                  <input type="hidden" name="phoneNumber" value={state.phoneNumber} />
                  <input type="hidden" name="content" value={state.content} />
                  <input type="hidden" name="repeatExternalId" value={state.externalMessageId} />
                  <button
                    type="submit"
                    disabled={pending}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    Reenviar a mesma mensagem (duplicata)
                  </button>
                </form>
              </div>
            </div>
          )}
          {state.status === "success" && state.replies.length > 0 && (
            <div className="space-y-2 rounded-md border border-line bg-surface-2 p-3 text-sm text-foreground">
              <p className="text-xs font-medium text-muted-2">Respostas da automação (o que o cliente veria)</p>
              {state.replies.map((reply, index) => (
                <div key={index} className="rounded-md border border-line px-3 py-2">
                  <Reply action={reply} onPick={setContent} />
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <div className="space-y-4">
        <AutomationCard key={selected.id} channel={selected} automation={automation} />
        <Card className="p-5">
          <p className="mb-3 text-sm font-medium text-foreground">Contatos deste canal</p>
          {contacts.length === 0 ? (
            <p className="text-sm text-muted">Nenhum ainda. Informe um telefone para criar um contato fictício.</p>
          ) : (
            <ul className="space-y-1.5">
              {contacts.map((contact) => (
                <li key={contact.contact_id}>
                  <button
                    type="button"
                    onClick={() => setPhone(contact.phone_number)}
                    aria-pressed={phone === contact.phone_number}
                    className={cn(
                      "w-full rounded-md border px-3 py-2 text-left text-xs transition-colors",
                      phone === contact.phone_number
                        ? "border-gold/40 bg-gold/10"
                        : "border-line hover:border-line-strong",
                    )}
                  >
                    <span className="block truncate text-sm text-foreground">{contact.name || contact.phone_number}</span>
                    <span className="flex items-center justify-between gap-2 text-muted-2">
                      <span>{contact.phone_number}</span>
                      <Badge tone={conversationStatusTone[contact.status]}>{conversationStatusLabel[contact.status]}</Badge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
