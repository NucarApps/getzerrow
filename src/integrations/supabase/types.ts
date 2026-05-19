export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      emails: {
        Row: {
          ai_confidence: number | null
          ai_summary: string | null
          body_html: string | null
          body_text: string | null
          classified_by: string | null
          created_at: string
          folder_id: string | null
          from_addr: string | null
          from_name: string | null
          gmail_account_id: string
          gmail_message_id: string
          has_attachment: boolean
          id: string
          is_archived: boolean
          is_read: boolean
          raw_labels: string[] | null
          received_at: string | null
          snippet: string | null
          subject: string | null
          thread_id: string | null
          to_addrs: string | null
          user_id: string
        }
        Insert: {
          ai_confidence?: number | null
          ai_summary?: string | null
          body_html?: string | null
          body_text?: string | null
          classified_by?: string | null
          created_at?: string
          folder_id?: string | null
          from_addr?: string | null
          from_name?: string | null
          gmail_account_id: string
          gmail_message_id: string
          has_attachment?: boolean
          id?: string
          is_archived?: boolean
          is_read?: boolean
          raw_labels?: string[] | null
          received_at?: string | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addrs?: string | null
          user_id: string
        }
        Update: {
          ai_confidence?: number | null
          ai_summary?: string | null
          body_html?: string | null
          body_text?: string | null
          classified_by?: string | null
          created_at?: string
          folder_id?: string | null
          from_addr?: string | null
          from_name?: string | null
          gmail_account_id?: string
          gmail_message_id?: string
          has_attachment?: boolean
          id?: string
          is_archived?: boolean
          is_read?: boolean
          raw_labels?: string[] | null
          received_at?: string | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addrs?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_gmail_account_id_fkey"
            columns: ["gmail_account_id"]
            isOneToOne: false
            referencedRelation: "gmail_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      folder_examples: {
        Row: {
          created_at: string
          folder_id: string
          from_addr: string | null
          gmail_account_id: string
          gmail_message_id: string
          id: string
          snippet: string | null
          source: string
          subject: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          folder_id: string
          from_addr?: string | null
          gmail_account_id: string
          gmail_message_id: string
          id?: string
          snippet?: string | null
          source?: string
          subject?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          folder_id?: string
          from_addr?: string | null
          gmail_account_id?: string
          gmail_message_id?: string
          id?: string
          snippet?: string | null
          source?: string
          subject?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "folder_examples_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folder_examples_gmail_account_id_fkey"
            columns: ["gmail_account_id"]
            isOneToOne: false
            referencedRelation: "gmail_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      folder_filters: {
        Row: {
          created_at: string
          field: string
          folder_id: string
          id: string
          op: string
          value: string
        }
        Insert: {
          created_at?: string
          field: string
          folder_id: string
          id?: string
          op: string
          value: string
        }
        Update: {
          created_at?: string
          field?: string
          folder_id?: string
          id?: string
          op?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "folder_filters_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
        ]
      }
      folders: {
        Row: {
          ai_rule: string | null
          auto_archive: boolean
          auto_mark_read: boolean
          color: string
          created_at: string
          gmail_account_id: string
          gmail_label_id: string | null
          id: string
          last_learned_at: string | null
          learned_profile: string | null
          name: string
          priority: number
          user_id: string
        }
        Insert: {
          ai_rule?: string | null
          auto_archive?: boolean
          auto_mark_read?: boolean
          color?: string
          created_at?: string
          gmail_account_id: string
          gmail_label_id?: string | null
          id?: string
          last_learned_at?: string | null
          learned_profile?: string | null
          name: string
          priority?: number
          user_id: string
        }
        Update: {
          ai_rule?: string | null
          auto_archive?: boolean
          auto_mark_read?: boolean
          color?: string
          created_at?: string
          gmail_account_id?: string
          gmail_label_id?: string | null
          id?: string
          last_learned_at?: string | null
          learned_profile?: string | null
          name?: string
          priority?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "folders_gmail_account_id_fkey"
            columns: ["gmail_account_id"]
            isOneToOne: false
            referencedRelation: "gmail_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      gmail_accounts: {
        Row: {
          access_token: string
          created_at: string
          email_address: string
          history_id: string | null
          id: string
          last_poll_at: string | null
          refresh_token: string
          token_expires_at: string
          updated_at: string
          user_id: string
          watch_expiration: string | null
        }
        Insert: {
          access_token: string
          created_at?: string
          email_address: string
          history_id?: string | null
          id?: string
          last_poll_at?: string | null
          refresh_token: string
          token_expires_at: string
          updated_at?: string
          user_id: string
          watch_expiration?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string
          email_address?: string
          history_id?: string | null
          id?: string
          last_poll_at?: string | null
          refresh_token?: string
          token_expires_at?: string
          updated_at?: string
          user_id?: string
          watch_expiration?: string | null
        }
        Relationships: []
      }
      reply_drafts: {
        Row: {
          created_at: string
          draft_text: string
          email_id: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          draft_text: string
          email_id: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          draft_text?: string
          email_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reply_drafts_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_state: {
        Row: {
          id: number
          last_history_id: string | null
          last_poll_at: string | null
          updated_at: string
          user_id: string | null
          watch_expiration: string | null
        }
        Insert: {
          id?: number
          last_history_id?: string | null
          last_poll_at?: string | null
          updated_at?: string
          user_id?: string | null
          watch_expiration?: string | null
        }
        Update: {
          id?: number
          last_history_id?: string | null
          last_poll_at?: string | null
          updated_at?: string
          user_id?: string | null
          watch_expiration?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
