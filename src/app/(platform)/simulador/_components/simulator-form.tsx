"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { conversationStatusLabel, conversationStatusTone } from "@/lib/labels";
import { cn } from "@/lib/utils/cn";
import { simulateInboundAction, type SimulatorActionState } from "@/modules/simulator/actions";
import type { SimulatorChannel, SimulatorContact } from "@/modules/simulator/sql-queries";

const INITIAL_STATE: SimulatorActionState = { status: "idle" };

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
}: {
  channels: SimulatorChannel[];
  selected: SimulatorChannel;
  contacts: SimulatorContact[];
  activeOrganizationId: string;
}) {
  const [state, formAction, pending] = useActionState(simulateInboundAction, INITIAL_STATE);
  const [phone, setPhone] = useState(contacts[0]?.phone_number ?? "");
  const [name, setName] = useState("");
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
        </div>
      </Card>

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
  );
}
