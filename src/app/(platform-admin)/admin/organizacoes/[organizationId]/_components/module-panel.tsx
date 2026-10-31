"use client";

import { useActionState } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { setOrganizationModuleAction } from "@/modules/organizations/actions";
import {
  MODULE_CATALOG,
  ORGANIZATION_MODULES,
  dependentsOf,
  isModuleChangeBlocked,
  moduleBlockReason,
  type ModuleActionState,
} from "@/modules/organizations/modules";
import type { OrganizationModuleSetting } from "@/modules/organizations/sql-queries";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

const INITIAL_STATE: ModuleActionState = { status: "idle" };

/**
 * Um único estado para os quatro formulários: enquanto uma alteração é salva,
 * todos os botões ficam desabilitados. A tela só orienta; quem decide é o banco.
 */
export function ModulePanel({
  organizationId,
  organizationName,
  settings,
}: {
  organizationId: string;
  organizationName: string;
  settings: OrganizationModuleSetting[];
}) {
  const [state, formAction, pending] = useActionState(setOrganizationModuleAction, INITIAL_STATE);
  const enabled = settings.filter((setting) => setting.enabled).map((setting) => setting.module);

  return (
    <div className="space-y-3">
      <div aria-live="polite">
        {state.status !== "idle" && (
          <p
            role={state.status === "error" ? "alert" : "status"}
            className={
              state.status === "error"
                ? "rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                : "rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
            }
          >
            {organizationName}: {state.message}
          </p>
        )}
      </div>

      <Card className="divide-y divide-line">
        {ORGANIZATION_MODULES.map((module) => {
          const definition = MODULE_CATALOG[module];
          const setting = settings.find((candidate) => candidate.module === module);
          const isEnabled = setting?.enabled ?? false;
          const blocked = isModuleChangeBlocked(module, !isEnabled, enabled);
          const dependents = dependentsOf(module);

          return (
            <section
              key={module}
              aria-label={definition.label}
              className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{definition.label}</h2>
                  <Badge tone={isEnabled ? "green" : "zinc"}>{isEnabled ? "Habilitado" : "Desabilitado"}</Badge>
                  {!definition.implemented && <Badge tone="amber">Em desenvolvimento</Badge>}
                </div>
                <p className="text-sm text-muted">{definition.description}</p>
                {definition.requires.length > 0 && (
                  <p className="text-xs text-muted-2">
                    Depende de {definition.requires.map((other) => MODULE_CATALOG[other].label).join(", ")}.
                  </p>
                )}
                {dependents.length > 0 && (
                  <p className="text-xs text-muted-2">
                    Necessário para {dependents.map((other) => MODULE_CATALOG[other].label).join(", ")}.
                  </p>
                )}
                {setting?.updated_by_name && (
                  <p className="text-xs text-muted-2">
                    Alterado por {setting.updated_by_name} em {dateFormatter.format(new Date(setting.updated_at))}.
                  </p>
                )}
                {blocked && <p className="text-xs text-amber-300">{moduleBlockReason(module, !isEnabled)}</p>}
              </div>

              <form action={formAction} className="shrink-0">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="module" value={module} />
                <input type="hidden" name="enabled" value={String(!isEnabled)} />
                <button
                  type="submit"
                  disabled={pending || blocked}
                  aria-busy={pending}
                  aria-label={`${isEnabled ? "Desabilitar" : "Habilitar"} ${definition.label} em ${organizationName}`}
                  className={buttonVariants({ variant: isEnabled ? "secondary" : "primary", size: "sm" })}
                >
                  {isEnabled ? "Desabilitar" : "Habilitar"}
                </button>
              </form>
            </section>
          );
        })}
      </Card>
    </div>
  );
}
