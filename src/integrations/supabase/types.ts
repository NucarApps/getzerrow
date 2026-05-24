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
      backfill_jobs: {
        Row: {
          already_had: number
          finished_at: string | null
          gmail_account_id: string
          id: string
          last_error: string | null
          months: number
          next_page_token: string | null
          query: string
          started_at: string
          status: string
          total_enqueued: number
          total_found: number
          updated_at: string
          user_id: string
        }
        Insert: {
          already_had?: number
          finished_at?: string | null
          gmail_account_id: string
          id?: string
          last_error?: string | null
          months?: number
          next_page_token?: string | null
          query: string
          started_at?: string
          status?: string
          total_enqueued?: number
          total_found?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          already_had?: number
          finished_at?: string | null
          gmail_account_id?: string
          id?: string
          last_error?: string | null
          months?: number
          next_page_token?: string | null
          query?: string
          started_at?: string
          status?: string
          total_enqueued?: number
          total_found?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      card_events: {
        Row: {
          card_id: string
          created_at: string
          event_type: string
          handle: string
          id: string
          link_kind: string | null
          link_url: string | null
          owner_user_id: string
          referrer: string | null
          user_agent: string | null
        }
        Insert: {
          card_id: string
          created_at?: string
          event_type: string
          handle: string
          id?: string
          link_kind?: string | null
          link_url?: string | null
          owner_user_id: string
          referrer?: string | null
          user_agent?: string | null
        }
        Update: {
          card_id?: string
          created_at?: string
          event_type?: string
          handle?: string
          id?: string
          link_kind?: string | null
          link_url?: string | null
          owner_user_id?: string
          referrer?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      contact_cards_sent: {
        Row: {
          contact_id: string | null
          id: string
          sent_at: string
          to_email: string
          user_id: string
        }
        Insert: {
          contact_id?: string | null
          id?: string
          sent_at?: string
          to_email: string
          user_id: string
        }
        Update: {
          contact_id?: string | null
          id?: string
          sent_at?: string
          to_email?: string
          user_id?: string
        }
        Relationships: []
      }
      contact_group_members: {
        Row: {
          contact_id: string
          created_at: string
          group_id: string
          user_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          group_id: string
          user_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          group_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_group_members_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "contact_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_groups: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      contacts: {
        Row: {
          avatar_url: string | null
          company: string | null
          created_at: string
          email: string
          enriched_at: string | null
          id: string
          linkedin: string | null
          name: string | null
          notes: string | null
          phone: string | null
          relationship_summary: string | null
          source: string
          summary_generated_at: string | null
          title: string | null
          twitter: string | null
          updated_at: string
          user_id: string
          website: string | null
        }
        Insert: {
          avatar_url?: string | null
          company?: string | null
          created_at?: string
          email: string
          enriched_at?: string | null
          id?: string
          linkedin?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          relationship_summary?: string | null
          source?: string
          summary_generated_at?: string | null
          title?: string | null
          twitter?: string | null
          updated_at?: string
          user_id: string
          website?: string | null
        }
        Update: {
          avatar_url?: string | null
          company?: string | null
          created_at?: string
          email?: string
          enriched_at?: string | null
          id?: string
          linkedin?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          relationship_summary?: string | null
          source?: string
          summary_generated_at?: string | null
          title?: string | null
          twitter?: string | null
          updated_at?: string
          user_id?: string
          website?: string | null
        }
        Relationships: []
      }
      emails: {
        Row: {
          ai_confidence: number | null
          ai_summary: string | null
          body_html: string | null
          body_text: string | null
          cc: string | null
          classification_reason: string | null
          classified_by: string | null
          created_at: string
          folder_id: string | null
          forwarded_at: string | null
          forwarded_to: string | null
          from_addr: string | null
          from_name: string | null
          gmail_account_id: string
          gmail_message_id: string
          has_attachment: boolean
          id: string
          in_reply_to: string | null
          is_archived: boolean
          is_read: boolean
          list_id: string | null
          matched_filter_ids: string[]
          matched_folder_ids: string[]
          processed_at: string | null
          raw_labels: string[] | null
          received_at: string | null
          snippet: string | null
          snoozed_until: string | null
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
          cc?: string | null
          classification_reason?: string | null
          classified_by?: string | null
          created_at?: string
          folder_id?: string | null
          forwarded_at?: string | null
          forwarded_to?: string | null
          from_addr?: string | null
          from_name?: string | null
          gmail_account_id: string
          gmail_message_id: string
          has_attachment?: boolean
          id?: string
          in_reply_to?: string | null
          is_archived?: boolean
          is_read?: boolean
          list_id?: string | null
          matched_filter_ids?: string[]
          matched_folder_ids?: string[]
          processed_at?: string | null
          raw_labels?: string[] | null
          received_at?: string | null
          snippet?: string | null
          snoozed_until?: string | null
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
          cc?: string | null
          classification_reason?: string | null
          classified_by?: string | null
          created_at?: string
          folder_id?: string | null
          forwarded_at?: string | null
          forwarded_to?: string | null
          from_addr?: string | null
          from_name?: string | null
          gmail_account_id?: string
          gmail_message_id?: string
          has_attachment?: boolean
          id?: string
          in_reply_to?: string | null
          is_archived?: boolean
          is_read?: boolean
          list_id?: string | null
          matched_filter_ids?: string[]
          matched_folder_ids?: string[]
          processed_at?: string | null
          raw_labels?: string[] | null
          received_at?: string | null
          snippet?: string | null
          snoozed_until?: string | null
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
      folder_summary_schedules: {
        Row: {
          created_at: string
          enabled: boolean
          folder_id: string
          gmail_account_id: string
          hour: number
          id: string
          instructions: string
          last_error: string | null
          last_run_at: string | null
          minute: number
          name: string
          next_run_at: string
          timezone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          folder_id: string
          gmail_account_id: string
          hour: number
          id?: string
          instructions?: string
          last_error?: string | null
          last_run_at?: string | null
          minute: number
          name: string
          next_run_at: string
          timezone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          folder_id?: string
          gmail_account_id?: string
          hour?: number
          id?: string
          instructions?: string
          last_error?: string | null
          last_run_at?: string | null
          minute?: number
          name?: string
          next_run_at?: string
          timezone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      folders: {
        Row: {
          ai_rule: string | null
          auto_archive: boolean
          auto_mark_read: boolean
          auto_relearn: boolean
          auto_star: boolean
          color: string
          created_at: string
          emails_since_learn: number
          filter_logic: string
          filter_tree: Json | null
          forward_to: string | null
          gmail_account_id: string
          gmail_backfill_oldest_received_at: string | null
          gmail_backfill_page_token: string | null
          gmail_label_id: string | null
          hide_from_inbox: boolean
          id: string
          last_learned_at: string | null
          learned_profile: string | null
          min_ai_confidence: number
          name: string
          overrides_inbox_override: boolean
          priority: number
          relearn_threshold: number
          skip_ai: boolean
          snooze_hours: number
          user_id: string
        }
        Insert: {
          ai_rule?: string | null
          auto_archive?: boolean
          auto_mark_read?: boolean
          auto_relearn?: boolean
          auto_star?: boolean
          color?: string
          created_at?: string
          emails_since_learn?: number
          filter_logic?: string
          filter_tree?: Json | null
          forward_to?: string | null
          gmail_account_id: string
          gmail_backfill_oldest_received_at?: string | null
          gmail_backfill_page_token?: string | null
          gmail_label_id?: string | null
          hide_from_inbox?: boolean
          id?: string
          last_learned_at?: string | null
          learned_profile?: string | null
          min_ai_confidence?: number
          name: string
          overrides_inbox_override?: boolean
          priority?: number
          relearn_threshold?: number
          skip_ai?: boolean
          snooze_hours?: number
          user_id: string
        }
        Update: {
          ai_rule?: string | null
          auto_archive?: boolean
          auto_mark_read?: boolean
          auto_relearn?: boolean
          auto_star?: boolean
          color?: string
          created_at?: string
          emails_since_learn?: number
          filter_logic?: string
          filter_tree?: Json | null
          forward_to?: string | null
          gmail_account_id?: string
          gmail_backfill_oldest_received_at?: string | null
          gmail_backfill_page_token?: string | null
          gmail_label_id?: string | null
          hide_from_inbox?: boolean
          id?: string
          last_learned_at?: string | null
          learned_profile?: string | null
          min_ai_confidence?: number
          name?: string
          overrides_inbox_override?: boolean
          priority?: number
          relearn_threshold?: number
          skip_ai?: boolean
          snooze_hours?: number
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
      inbox_override_exceptions: {
        Row: {
          created_at: string
          field: string
          id: string
          op: string
          override_id: string
          user_id: string
          value: string
        }
        Insert: {
          created_at?: string
          field: string
          id?: string
          op: string
          override_id: string
          user_id: string
          value: string
        }
        Update: {
          created_at?: string
          field?: string
          id?: string
          op?: string
          override_id?: string
          user_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_override_exceptions_override_id_fkey"
            columns: ["override_id"]
            isOneToOne: false
            referencedRelation: "inbox_overrides"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_overrides: {
        Row: {
          created_at: string
          id: string
          match_type: string
          note: string | null
          user_id: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          match_type: string
          note?: string | null
          user_id: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          match_type?: string
          note?: string | null
          user_id?: string
          value?: string
        }
        Relationships: []
      }
      message_jobs: {
        Row: {
          attempt: number
          created_at: string
          from_addr: string | null
          gmail_account_id: string
          gmail_message_id: string
          id: string
          last_error: string | null
          locked_at: string | null
          next_run_at: string
          priority: number
          status: string
          subject: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          from_addr?: string | null
          gmail_account_id: string
          gmail_message_id: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          next_run_at?: string
          priority?: number
          status?: string
          subject?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt?: number
          created_at?: string
          from_addr?: string | null
          gmail_account_id?: string
          gmail_message_id?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          next_run_at?: string
          priority?: number
          status?: string
          subject?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      my_cards: {
        Row: {
          avatar_url: string | null
          company: string | null
          cover_url: string | null
          created_at: string
          email: string | null
          handle: string
          id: string
          linkedin: string | null
          name: string | null
          phone: string | null
          tagline: string | null
          theme: string
          title: string | null
          twitter: string | null
          updated_at: string
          user_id: string
          website: string | null
        }
        Insert: {
          avatar_url?: string | null
          company?: string | null
          cover_url?: string | null
          created_at?: string
          email?: string | null
          handle: string
          id?: string
          linkedin?: string | null
          name?: string | null
          phone?: string | null
          tagline?: string | null
          theme?: string
          title?: string | null
          twitter?: string | null
          updated_at?: string
          user_id: string
          website?: string | null
        }
        Update: {
          avatar_url?: string | null
          company?: string | null
          cover_url?: string | null
          created_at?: string
          email?: string | null
          handle?: string
          id?: string
          linkedin?: string | null
          name?: string | null
          phone?: string | null
          tagline?: string | null
          theme?: string
          title?: string | null
          twitter?: string | null
          updated_at?: string
          user_id?: string
          website?: string | null
        }
        Relationships: []
      }
      pubsub_events: {
        Row: {
          accounts_matched: number | null
          details: string | null
          email_address: string | null
          error: string | null
          event_type: string
          history_id: string | null
          id: string
          message_id: string | null
          payload: Json | null
          publish_time: string | null
          received_at: string
          subscription: string | null
          synced_count: number | null
        }
        Insert: {
          accounts_matched?: number | null
          details?: string | null
          email_address?: string | null
          error?: string | null
          event_type?: string
          history_id?: string | null
          id?: string
          message_id?: string | null
          payload?: Json | null
          publish_time?: string | null
          received_at?: string
          subscription?: string | null
          synced_count?: number | null
        }
        Update: {
          accounts_matched?: number | null
          details?: string | null
          email_address?: string | null
          error?: string | null
          event_type?: string
          history_id?: string | null
          id?: string
          message_id?: string | null
          payload?: Json | null
          publish_time?: string | null
          received_at?: string
          subscription?: string | null
          synced_count?: number | null
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
          user_id: string
          watch_expiration: string | null
        }
        Insert: {
          id?: number
          last_history_id?: string | null
          last_poll_at?: string | null
          updated_at?: string
          user_id: string
          watch_expiration?: string | null
        }
        Update: {
          id?: number
          last_history_id?: string | null
          last_poll_at?: string | null
          updated_at?: string
          user_id?: string
          watch_expiration?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_message_jobs: {
        Args: { p_limit: number; p_priority?: number }
        Returns: {
          attempt: number
          gmail_account_id: string
          gmail_message_id: string
          id: string
          priority: number
          user_id: string
        }[]
      }
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
