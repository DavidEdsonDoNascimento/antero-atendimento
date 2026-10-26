import type { MemberRole, MemberStatus } from "@/lib/types/database";

/** Membro da organização com nome e e-mail do perfil (`profile` null quando a RLS o oculta). */
export type OrganizationMemberRow = {
  id: string;
  role: MemberRole;
  status: MemberStatus;
  created_at: string;
  profile: {
    id: string;
    full_name: string | null;
    email: string;
  } | null;
};
