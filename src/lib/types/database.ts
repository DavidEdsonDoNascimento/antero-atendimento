/**
 * Tipos do banco de dados (Ciclo 1).
 *
 * Escrito à mão e mantido em sincronia com as migrations em `supabase/migrations`.
 * Quando o Supabase CLI estiver disponível no projeto, estes tipos podem ser
 * regenerados com:
 *
 *   npx supabase gen types typescript --linked > src/lib/types/database.ts
 *
 * Enquanto isso, cada ciclo que adicionar tabelas deve estender este arquivo.
 */

export type OrganizationStatus = "active" | "inactive";
export type MemberRole = "owner" | "admin" | "attendant";
export type MemberStatus = "active" | "invited" | "disabled";
export type WhatsappProvider = "development" | "cloud_api";
export type WhatsappStatus = "connected" | "disconnected";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          is_platform_admin: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          is_platform_admin?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          is_platform_admin?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          status: OrganizationStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          status?: OrganizationStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          status?: OrganizationStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          role: MemberRole;
          status: MemberStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role?: MemberRole;
          status?: MemberStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          role?: MemberRole;
          status?: MemberStatus;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey";
            columns: ["organization_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "organization_members_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      whatsapp_accounts: {
        Row: {
          id: string;
          organization_id: string;
          provider: WhatsappProvider;
          external_account_id: string | null;
          phone_number: string | null;
          display_name: string | null;
          status: WhatsappStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          provider?: WhatsappProvider;
          external_account_id?: string | null;
          phone_number?: string | null;
          display_name?: string | null;
          status?: WhatsappStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider?: WhatsappProvider;
          external_account_id?: string | null;
          phone_number?: string | null;
          display_name?: string | null;
          status?: WhatsappStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "whatsapp_accounts_organization_id_fkey";
            columns: ["organization_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      is_platform_admin: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      is_org_member: {
        Args: { org_id: string };
        Returns: boolean;
      };
      is_org_admin: {
        Args: { org_id: string };
        Returns: boolean;
      };
      shares_org_with: {
        Args: { target_user: string };
        Returns: boolean;
      };
    };
    Enums: {
      organization_status: OrganizationStatus;
      member_role: MemberRole;
      member_status: MemberStatus;
      whatsapp_provider: WhatsappProvider;
      whatsapp_status: WhatsappStatus;
    };
    CompositeTypes: Record<never, never>;
  };
};

// Atalhos utilitários usados pelos módulos.
export type Organization = Database["public"]["Tables"]["organizations"]["Row"];
export type OrganizationMember =
  Database["public"]["Tables"]["organization_members"]["Row"];
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type WhatsappAccount =
  Database["public"]["Tables"]["whatsapp_accounts"]["Row"];
