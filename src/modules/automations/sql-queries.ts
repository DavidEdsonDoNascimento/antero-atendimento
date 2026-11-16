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
  /** O rascunho difere da versão publicada (ou nunca foi publicado). */
  hasDraftChanges: boolean;
  draftUpdatedAt: string;
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
      has_draft_changes: boolean;
      draft_updated_at: string;
      active_sessions: string;
    }>(
      `SELECT f.id, f.slug, f.name, f.status, f.is_entry, v.version, v.published_at, f.draft_revision,
              f.draft_definition IS DISTINCT FROM v.definition AS has_draft_changes, f.draft_updated_at,
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
      hasDraftChanges: row.has_draft_changes,
      draftUpdatedAt: row.draft_updated_at,
      activeSessions: Number(row.active_sessions),
    }));
  });
}

export type FlowForEditor = {
  id: string;
  name: string;
  status: AutomationFlowStatus;
  isEntry: boolean;
  /** Outro fluxo da organização que já responde às conversas novas (só pode haver um). */
  otherEntryFlowName: string | null;
  draftDefinition: unknown;
  draftRevision: number;
  draftUpdatedAt: string;
  /** Nulo quando quem gravou não é mais membro ativo (o perfil deixa de ser visível). */
  draftUpdatedByName: string | null;
  publishedVersion: number | null;
  publishedAt: string | null;
  hasDraftChanges: boolean;
};

/** Fluxo inteiro, com o rascunho, para o editor. `null`: não existe nesta organização. */
export async function getFlowForEditor(context: OrganizationContext, flowId: string): Promise<FlowForEditor | null> {
  return withModuleTransaction(context, "automacoes", async (tx) => {
    const row = (
      await tx.query<{
        id: string;
        name: string;
        status: AutomationFlowStatus;
        is_entry: boolean;
        other_entry: string | null;
        draft_definition: unknown;
        draft_revision: number;
        draft_updated_at: string;
        draft_updated_by_name: string | null;
        version: number | null;
        published_at: string | null;
        has_draft_changes: boolean;
      }>(
        `SELECT f.id, f.name, f.status, f.is_entry, f.draft_definition, f.draft_revision, f.draft_updated_at,
                nullif(btrim(p.full_name), '') AS draft_updated_by_name, v.version, v.published_at,
                f.draft_definition IS DISTINCT FROM v.definition AS has_draft_changes,
                (SELECT o.name FROM public.automation_flows o
                 WHERE o.organization_id = f.organization_id AND o.is_entry AND o.id <> f.id) AS other_entry
         FROM public.automation_flows f
         LEFT JOIN public.automation_flow_versions v
           ON v.organization_id = f.organization_id AND v.id = f.published_version_id
         LEFT JOIN public.profiles p ON p.id = f.draft_updated_by
         WHERE f.organization_id = $1::uuid AND f.id = $2::uuid`,
        [context.organizationId, flowId],
      )
    ).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      isEntry: row.is_entry,
      otherEntryFlowName: row.other_entry,
      draftDefinition: row.draft_definition,
      draftRevision: row.draft_revision,
      draftUpdatedAt: row.draft_updated_at,
      draftUpdatedByName: row.draft_updated_by_name,
      publishedVersion: row.version,
      publishedAt: row.published_at,
      hasDraftChanges: row.has_draft_changes,
    };
  });
}

/** Nome do fluxo de entrada da organização, se houver (tela de criação). */
export async function getEntryFlowName(context: OrganizationContext): Promise<string | null> {
  return withModuleTransaction(context, "automacoes", async (tx) => {
    const { rows } = await tx.query<{ name: string }>(
      "SELECT name FROM public.automation_flows WHERE organization_id = $1::uuid AND is_entry",
      [context.organizationId],
    );
    return rows[0]?.name ?? null;
  });
}

export type FlowVersionSummary = {
  version: number;
  publishedAt: string;
  /** Nulo quando quem publicou não é mais membro ativo. */
  publishedByName: string | null;
  isCurrent: boolean;
};

/** Versões publicadas de um fluxo, da mais nova para a mais antiga. */
export async function listFlowVersions(context: OrganizationContext, flowId: string): Promise<FlowVersionSummary[]> {
  return withModuleTransaction(context, "automacoes", async (tx) => {
    const { rows } = await tx.query<{ version: number; published_at: string; name: string | null; is_current: boolean }>(
      `SELECT v.version, v.published_at, nullif(btrim(p.full_name), '') AS name, v.id = f.published_version_id AS is_current
       FROM public.automation_flow_versions v
       JOIN public.automation_flows f ON f.organization_id = v.organization_id AND f.id = v.flow_id
       LEFT JOIN public.profiles p ON p.id = v.published_by
       WHERE v.organization_id = $1::uuid AND v.flow_id = $2::uuid
       ORDER BY v.version DESC`,
      [context.organizationId, flowId],
    );
    return rows.map((row) => ({
      version: row.version,
      publishedAt: row.published_at,
      publishedByName: row.name,
      isCurrent: row.is_current,
    }));
  });
}

export type FlowVersionDetail = FlowVersionSummary & { definition: unknown };

export async function getFlowVersion(
  context: OrganizationContext,
  flowId: string,
  version: number,
): Promise<FlowVersionDetail | null> {
  return withModuleTransaction(context, "automacoes", async (tx) => {
    const row = (
      await tx.query<{ version: number; published_at: string; name: string | null; is_current: boolean; definition: unknown }>(
        `SELECT v.version, v.published_at, nullif(btrim(p.full_name), '') AS name,
                v.id = f.published_version_id AS is_current, v.definition
         FROM public.automation_flow_versions v
         JOIN public.automation_flows f ON f.organization_id = v.organization_id AND f.id = v.flow_id
         LEFT JOIN public.profiles p ON p.id = v.published_by
         WHERE v.organization_id = $1::uuid AND v.flow_id = $2::uuid AND v.version = $3::integer`,
        [context.organizationId, flowId, version],
      )
    ).rows[0];
    if (!row) return null;
    return {
      version: row.version,
      publishedAt: row.published_at,
      publishedByName: row.name,
      isCurrent: row.is_current,
      definition: row.definition,
    };
  });
}

export type FlowImage = { id: string; fileName: string; contentType: string; byteSize: number; createdAt: string };

/** Imagens enviadas pela organização, das mais novas para as mais antigas (sem o conteúdo). */
export async function listFlowImages(context: OrganizationContext): Promise<FlowImage[]> {
  return withModuleTransaction(context, "automacoes", async (tx) => {
    const { rows } = await tx.query<{ id: string; file_name: string; content_type: string; byte_size: number; created_at: string }>(
      `SELECT id, file_name, content_type, byte_size, created_at FROM public.automation_media
       WHERE organization_id = $1::uuid
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [context.organizationId],
    );
    return rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      contentType: row.content_type,
      byteSize: row.byte_size,
      createdAt: row.created_at,
    }));
  });
}

/** Conteúdo de uma imagem da organização, para a prévia e o editor. */
export async function getFlowImageContent(
  context: OrganizationContext,
  mediaId: string,
): Promise<{ contentType: string; data: Buffer } | null> {
  return withModuleTransaction(context, "automacoes", async (tx) => {
    const row = (
      await tx.query<{ content_type: string; data: Buffer }>(
        "SELECT content_type, data FROM public.automation_media WHERE organization_id = $1::uuid AND id = $2::uuid",
        [context.organizationId, mediaId],
      )
    ).rows[0];
    return row ? { contentType: row.content_type, data: row.data } : null;
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
