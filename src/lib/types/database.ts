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
export type ConversationStatus = "bot" | "waiting" | "human" | "resolved";
export type MessageDirection = "inbound" | "outbound";
export type MessageSender = "contact" | "bot" | "user" | "system";
export type MessageType = "text";
export type MessageDeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

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
      contacts: {
        Row: {
          id: string;
          organization_id: string;
          name: string | null;
          phone_number: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name?: string | null;
          phone_number: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string | null;
          phone_number?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_organization_id_fkey";
            columns: ["organization_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      conversations: {
        Row: {
          id: string;
          organization_id: string;
          whatsapp_account_id: string;
          contact_id: string;
          status: ConversationStatus;
          assigned_user_id: string | null;
          assigned_at: string | null;
          started_at: string;
          last_message_at: string;
          resolved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          whatsapp_account_id: string;
          contact_id: string;
          status?: ConversationStatus;
          assigned_user_id?: string | null;
          assigned_at?: string | null;
          started_at?: string;
          last_message_at?: string;
          resolved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          whatsapp_account_id?: string;
          contact_id?: string;
          status?: ConversationStatus;
          assigned_user_id?: string | null;
          assigned_at?: string | null;
          started_at?: string;
          last_message_at?: string;
          resolved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_whatsapp_account_id_fkey";
            columns: ["organization_id", "whatsapp_account_id"];
            referencedRelation: "whatsapp_accounts";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "conversations_contact_id_fkey";
            columns: ["organization_id", "contact_id"];
            referencedRelation: "contacts";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "conversations_assigned_user_id_fkey";
            columns: ["organization_id", "assigned_user_id"];
            referencedRelation: "organization_members";
            referencedColumns: ["organization_id", "user_id"];
          },
        ];
      };
      messages: {
        Row: {
          id: string;
          organization_id: string;
          conversation_id: string;
          whatsapp_account_id: string;
          external_message_id: string | null;
          direction: MessageDirection;
          sender_type: MessageSender;
          sender_user_id: string | null;
          message_type: MessageType;
          content: string;
          delivery_status: MessageDeliveryStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          conversation_id: string;
          whatsapp_account_id: string;
          external_message_id?: string | null;
          direction: MessageDirection;
          sender_type: MessageSender;
          sender_user_id?: string | null;
          message_type?: MessageType;
          content: string;
          delivery_status?: MessageDeliveryStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          conversation_id?: string;
          whatsapp_account_id?: string;
          external_message_id?: string | null;
          direction?: MessageDirection;
          sender_type?: MessageSender;
          sender_user_id?: string | null;
          message_type?: MessageType;
          content?: string;
          delivery_status?: MessageDeliveryStatus;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_whatsapp_account_fkey";
            columns: ["organization_id", "conversation_id", "whatsapp_account_id"];
            referencedRelation: "conversations";
            referencedColumns: ["organization_id", "id", "whatsapp_account_id"];
          },
          {
            foreignKeyName: "messages_sender_user_id_fkey";
            columns: ["organization_id", "sender_user_id"];
            referencedRelation: "organization_members";
            referencedColumns: ["organization_id", "user_id"];
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
      conversation_status: ConversationStatus;
      message_direction: MessageDirection;
      message_sender: MessageSender;
      message_type: MessageType;
      message_delivery_status: MessageDeliveryStatus;
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
export type Contact = Database["public"]["Tables"]["contacts"]["Row"];
export type Conversation =
  Database["public"]["Tables"]["conversations"]["Row"];
export type Message = Database["public"]["Tables"]["messages"]["Row"];
