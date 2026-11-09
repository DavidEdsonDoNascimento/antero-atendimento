import "server-only";

import { withModuleTransaction, type OrganizationContext } from "@/lib/db";
import type { AutomationFlowStatus, AutomationSessionStatus } from "@/lib/types/database";

// Extensão .ts explícita nas importações de VALOR (ver nota em cursor.ts).
import { isSessionState } from "./engine.ts";

/**
 * Leituras da automação. Mesmas garantias das demais consultas: contexto do DAL,
 * módulo conferido na transação e RLS (0010) como defesa final.
 */

export type FlowSummary = {
  id: string;
  slug: string;
  name: string;
  status: AutomationFlowStatus;
  isEntry: boolean;
  publishedVersion: number | null;
  publishedAt: string | null;
  draftRevision: number;
  activeSessions: number;
};

/** Fluxos da organização (módulo Automações). */
export async function listFlows(context: OrganizationContext): Promise<FlowSummary[]> {
  return withModuleTransaction(context, "automacoes", async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      slug: string;
      name: string;
      status: AutomationFlowStatus;
      is_entry: boolean;
      version: number | null;
      published_at: string | null;
      draft_revision: number;
      active_sessions: string;
    }>(
      `SELECT f.id, f.slug, f.name, f.status, f.is_entry, v.version, v.published_at, f.draft_revision,
              (SELECT count(*) FROM public.automation_sessions s
               WHERE s.organization_id = f.organization_id AND s.flow_id = f.id AND s.status = 'active') AS active_sessions
       FROM public.automation_flows f
       LEFT JOIN public.automation_flow_versions v
         ON v.organization_id = f.organization_id AND v.id = f.published_version_id
       WHERE f.organization_id = $1::uuid
       ORDER BY f.is_entry DESC, f.name, f.id`,
      [context.organizationId],
    );
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      isEntry: row.is_entry,
      publishedVersion: row.version,
      publishedAt: row.published_at,
      draftRevision: row.draft_revision,
      activeSessions: Number(row.active_sessions),
    }));
  });
}

export type ConversationAutomation = {
  sessionId: string;
  status: AutomationSessionStatus;
  endReason: string | null;
  /** Nome do fluxo; nulo quando a organização não tem mais o módulo Automações (a RLS oculta o fluxo). */
  flowName: string | null;
  version: number | null;
  startedAt: string;
  endedAt: string | null;
  answers: { key: string; label: string; value: string }[];
};

/**
 * Última sessão de automação da conversa, com os dados coletados — o que o
 * atendente precisa ao assumir uma conversa encaminhada. Lida pela Inbox
 * (módulo Atendimento): a política de `automation_sessions` aceita os dois módulos.
 */
export async function getConversationAutomation(
  context: OrganizationContext,
  conversationId: string,
): Promise<ConversationAutomation | null> {
  return withModuleTransaction(context, "atendimento", async (tx) => {
    const row = (
      await tx.query<{
        id: string;
        status: AutomationSessionStatus;
        end_reason: string | null;
        state: unknown;
        started_at: string;
        ended_at: string | null;
        name: string | null;
        version: number | null;
      }>(
        `SELECT s.id, s.status, s.end_reason, s.state, s.started_at, s.ended_at, f.name, v.version
         FROM public.automation_sessions s
         LEFT JOIN public.automation_flows f ON f.organization_id = s.organization_id AND f.id = s.flow_id
         LEFT JOIN public.automation_flow_versions v ON v.organization_id = s.organization_id AND v.id = s.flow_version_id
         WHERE s.organization_id = $1::uuid AND s.conversation_id = $2::uuid
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT 1`,
        [context.organizationId, conversationId],
      )
    ).rows[0];
    if (!row) return null;
    const answers = isSessionState(row.state) ? row.state.answers : [];
    return {
      sessionId: row.id,
      status: row.status,
      endReason: row.end_reason,
      flowName: row.name,
      version: row.version,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      answers,
    };
  });
}
