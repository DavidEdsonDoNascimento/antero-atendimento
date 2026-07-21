import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import type { MemberRole, Organization, Profile } from "@/lib/types/database";

/**
 * Data Access Layer (DAL).
 *
 * Centraliza a verificação de sessão e a resolução da organização ativa.
 * Todas as páginas e ações autenticadas devem passar por aqui — nunca confie em
 * checagens apenas na UI. As funções usam `cache()` do React para deduplicar
 * consultas dentro de uma mesma renderização.
 */

export const getSessionUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export const requireUser = cache(async () => {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
});

export const getProfile = cache(async (): Promise<Profile | null> => {
  const user = await requireUser();
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  return data;
});

export type ActiveContext = {
  userId: string;
  profile: Profile;
  organization: Organization;
  role: MemberRole;
};

/**
 * Resolve o contexto ativo do usuário: perfil + organização + papel.
 * No MVP, um usuário pertence a uma organização — usamos a primeira associação
 * ativa. Retorna `null` quando o usuário ainda não está vinculado a nenhuma.
 */
export const getActiveContext = cache(
  async (): Promise<ActiveContext | null> => {
    const user = await requireUser();
    const supabase = await createClient();

    const [profile, { data: membership }] = await Promise.all([
      getProfile(),
      supabase
        .from("organization_members")
        .select("role, organization_id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    if (!profile || !membership) {
      return null;
    }

    const { data: organization } = await supabase
      .from("organizations")
      .select("*")
      .eq("id", membership.organization_id)
      .maybeSingle();

    if (!organization) {
      return null;
    }

    return {
      userId: user.id,
      profile,
      organization,
      role: membership.role,
    };
  },
);

export const requireActiveContext = cache(async (): Promise<ActiveContext> => {
  const context = await getActiveContext();
  if (!context) redirect("/sem-organizacao");
  return context;
});

export const requirePlatformAdmin = cache(async (): Promise<Profile> => {
  const profile = await getProfile();
  if (!profile?.is_platform_admin) redirect("/visao-geral");
  return profile;
});
