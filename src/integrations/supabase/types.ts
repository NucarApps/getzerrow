export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      backfill_jobs: {
        Row: {
          already_had: number;
          finished_at: string | null;
          gmail_account_id: string;
          id: string;
          last_error: string | null;
          months: number;
          next_page_token: string | null;
          query: string;
          started_at: string;
          status: string;
          total_enqueued: number;
          total_found: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          already_had?: number;
          finished_at?: string | null;
          gmail_account_id: string;
          id?: string;
          last_error?: string | null;
          months?: number;
          next_page_token?: string | null;
          query: string;
          started_at?: string;
          status?: string;
          total_enqueued?: number;
          total_found?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          already_had?: number;
          finished_at?: string | null;
          gmail_account_id?: string;
          id?: string;
          last_error?: string | null;
          months?: number;
          next_page_token?: string | null;
          query?: string;
          started_at?: string;
          status?: string;
          total_enqueued?: number;
          total_found?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      calendar_contacts: {
        Row: {
          created_at: string;
          email_address: string;
          gmail_account_id: string;
          id: string;
          last_seen_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          email_address: string;
          gmail_account_id: string;
          id?: string;
          last_seen_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          email_address?: string;
          gmail_account_id?: string;
          id?: string;
          last_seen_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      card_events: {
        Row: {
          card_id: string;
          created_at: string;
          event_type: string;
          handle: string;
          id: string;
          link_kind: string | null;
          link_url: string | null;
          owner_user_id: string;
          referrer: string | null;
          user_agent: string | null;
        };
        Insert: {
          card_id: string;
          created_at?: string;
          event_type: string;
          handle: string;
          id?: string;
          link_kind?: string | null;
          link_url?: string | null;
          owner_user_id: string;
          referrer?: string | null;
          user_agent?: string | null;
        };
        Update: {
          card_id?: string;
          created_at?: string;
          event_type?: string;
          handle?: string;
          id?: string;
          link_kind?: string | null;
          link_url?: string | null;
          owner_user_id?: string;
          referrer?: string | null;
          user_agent?: string | null;
        };
        Relationships: [];
      };
      company_aliases: {
        Row: {
          alias_domain: string;
          created_at: string;
          primary_domain: string;
          user_id: string;
        };
        Insert: {
          alias_domain: string;
          created_at?: string;
          primary_domain: string;
          user_id: string;
        };
        Update: {
          alias_domain?: string;
          created_at?: string;
          primary_domain?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      company_group_assignments: {
        Row: {
          created_at: string;
          group_id: string;
          primary_domain: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          group_id: string;
          primary_domain: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          group_id?: string;
          primary_domain?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      company_logo_choices: {
        Row: {
          domain: string;
          provider: number;
          source_domain: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          domain: string;
          provider: number;
          source_domain?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          domain?: string;
          provider?: number;
          source_domain?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      contact_cards_sent: {
        Row: {
          contact_id: string | null;
          id: string;
          sent_at: string;
          to_email: string;
          user_id: string;
        };
        Insert: {
          contact_id?: string | null;
          id?: string;
          sent_at?: string;
          to_email: string;
          user_id: string;
        };
        Update: {
          contact_id?: string | null;
          id?: string;
          sent_at?: string;
          to_email?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      contact_group_members: {
        Row: {
          contact_id: string;
          created_at: string;
          group_id: string;
          user_id: string;
        };
        Insert: {
          contact_id: string;
          created_at?: string;
          group_id: string;
          user_id: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          group_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_group_members_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "contact_groups";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_groups: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          color?: string;
          created_at?: string;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      contact_phones: {
        Row: {
          contact_id: string;
          created_at: string;
          id: string;
          is_primary: boolean;
          label: string;
          number: string;
          position: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          contact_id: string;
          created_at?: string;
          id?: string;
          is_primary?: boolean;
          label?: string;
          number: string;
          position?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          id?: string;
          is_primary?: boolean;
          label?: string;
          number?: string;
          position?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_phones_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      contacts: {
        Row: {
          address_line1_enc: string | null;
          address_line2_enc: string | null;
          avatar_url: string | null;
          card_image_url: string | null;
          city: string | null;
          company: string | null;
          country: string | null;
          created_at: string;
          email: string;
          enriched_at: string | null;
          id: string;
          key_version: number;
          linkedin: string | null;
          name: string | null;
          notes_enc: string | null;
          phone_enc: string | null;
          postal_code: string | null;
          region: string | null;
          relationship_summary_enc: string | null;
          source: string;
          summary_generated_at: string | null;
          title: string | null;
          twitter: string | null;
          updated_at: string;
          user_id: string;
          website: string | null;
        };
        Insert: {
          address_line1_enc?: string | null;
          address_line2_enc?: string | null;
          avatar_url?: string | null;
          card_image_url?: string | null;
          city?: string | null;
          company?: string | null;
          country?: string | null;
          created_at?: string;
          email: string;
          enriched_at?: string | null;
          id?: string;
          key_version?: number;
          linkedin?: string | null;
          name?: string | null;
          notes_enc?: string | null;
          phone_enc?: string | null;
          postal_code?: string | null;
          region?: string | null;
          relationship_summary_enc?: string | null;
          source?: string;
          summary_generated_at?: string | null;
          title?: string | null;
          twitter?: string | null;
          updated_at?: string;
          user_id: string;
          website?: string | null;
        };
        Update: {
          address_line1_enc?: string | null;
          address_line2_enc?: string | null;
          avatar_url?: string | null;
          card_image_url?: string | null;
          city?: string | null;
          company?: string | null;
          country?: string | null;
          created_at?: string;
          email?: string;
          enriched_at?: string | null;
          id?: string;
          key_version?: number;
          linkedin?: string | null;
          name?: string | null;
          notes_enc?: string | null;
          phone_enc?: string | null;
          postal_code?: string | null;
          region?: string | null;
          relationship_summary_enc?: string | null;
          source?: string;
          summary_generated_at?: string | null;
          title?: string | null;
          twitter?: string | null;
          updated_at?: string;
          user_id?: string;
          website?: string | null;
        };
        Relationships: [];
      };
      device_push_tokens: {
        Row: {
          created_at: string;
          expo_token: string;
          id: string;
          platform: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          expo_token: string;
          id?: string;
          platform?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          expo_token?: string;
          id?: string;
          platform?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      email_search_index: {
        Row: {
          email_id: string;
          gmail_account_id: string | null;
          has_sender: boolean;
          participant_tsv: unknown;
          received_at: string | null;
          tsv: unknown;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          email_id: string;
          gmail_account_id?: string | null;
          has_sender?: boolean;
          participant_tsv?: unknown;
          received_at?: string | null;
          tsv: unknown;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          email_id?: string;
          gmail_account_id?: string | null;
          has_sender?: boolean;
          participant_tsv?: unknown;
          received_at?: string | null;
          tsv?: unknown;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      emails: {
        Row: {
          ai_confidence: number | null;
          ai_summary_enc: string | null;
          body_html_enc: string | null;
          body_text_enc: string | null;
          cc_enc: string | null;
          classification_reason_enc: string | null;
          classified_by: string | null;
          classify_attempts: number;
          created_at: string;
          folder_id: string | null;
          forward_attempts: number;
          forward_last_error: string | null;
          forward_locked_at: string | null;
          forward_next_retry_at: string | null;
          forwarded_at: string | null;
          forwarded_to: string | null;
          from_addr: string | null;
          from_name_enc: string | null;
          gmail_account_id: string;
          gmail_message_id: string;
          has_attachment: boolean;
          id: string;
          in_reply_to: string | null;
          is_archived: boolean;
          is_read: boolean;
          key_version: number;
          list_id: string | null;
          matched_filter_ids: string[];
          matched_folder_ids: string[];
          processed_at: string | null;
          published_at_ms: number | null;
          raw_labels: string[] | null;
          received_at: string | null;
          snippet_enc: string | null;
          snoozed_until: string | null;
          subject_enc: string | null;
          surfaced_to_inbox: boolean;
          thread_id: string | null;
          to_addrs_enc: string | null;
          user_id: string;
        };
        Insert: {
          ai_confidence?: number | null;
          ai_summary_enc?: string | null;
          body_html_enc?: string | null;
          body_text_enc?: string | null;
          cc_enc?: string | null;
          classification_reason_enc?: string | null;
          classified_by?: string | null;
          classify_attempts?: number;
          created_at?: string;
          folder_id?: string | null;
          forward_attempts?: number;
          forward_last_error?: string | null;
          forward_locked_at?: string | null;
          forward_next_retry_at?: string | null;
          forwarded_at?: string | null;
          forwarded_to?: string | null;
          from_addr?: string | null;
          from_name_enc?: string | null;
          gmail_account_id: string;
          gmail_message_id: string;
          has_attachment?: boolean;
          id?: string;
          in_reply_to?: string | null;
          is_archived?: boolean;
          is_read?: boolean;
          key_version?: number;
          list_id?: string | null;
          matched_filter_ids?: string[];
          matched_folder_ids?: string[];
          processed_at?: string | null;
          published_at_ms?: number | null;
          raw_labels?: string[] | null;
          received_at?: string | null;
          snippet_enc?: string | null;
          snoozed_until?: string | null;
          subject_enc?: string | null;
          surfaced_to_inbox?: boolean;
          thread_id?: string | null;
          to_addrs_enc?: string | null;
          user_id: string;
        };
        Update: {
          ai_confidence?: number | null;
          ai_summary_enc?: string | null;
          body_html_enc?: string | null;
          body_text_enc?: string | null;
          cc_enc?: string | null;
          classification_reason_enc?: string | null;
          classified_by?: string | null;
          classify_attempts?: number;
          created_at?: string;
          folder_id?: string | null;
          forward_attempts?: number;
          forward_last_error?: string | null;
          forward_locked_at?: string | null;
          forward_next_retry_at?: string | null;
          forwarded_at?: string | null;
          forwarded_to?: string | null;
          from_addr?: string | null;
          from_name_enc?: string | null;
          gmail_account_id?: string;
          gmail_message_id?: string;
          has_attachment?: boolean;
          id?: string;
          in_reply_to?: string | null;
          is_archived?: boolean;
          is_read?: boolean;
          key_version?: number;
          list_id?: string | null;
          matched_filter_ids?: string[];
          matched_folder_ids?: string[];
          processed_at?: string | null;
          published_at_ms?: number | null;
          raw_labels?: string[] | null;
          received_at?: string | null;
          snippet_enc?: string | null;
          snoozed_until?: string | null;
          subject_enc?: string | null;
          surfaced_to_inbox?: boolean;
          thread_id?: string | null;
          to_addrs_enc?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "emails_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "emails_gmail_account_id_fkey";
            columns: ["gmail_account_id"];
            isOneToOne: false;
            referencedRelation: "gmail_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      folder_examples: {
        Row: {
          created_at: string;
          folder_id: string;
          from_addr: string | null;
          gmail_account_id: string;
          gmail_message_id: string;
          id: string;
          key_version: number;
          snippet_enc: string | null;
          source: string;
          subject_enc: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          folder_id: string;
          from_addr?: string | null;
          gmail_account_id: string;
          gmail_message_id: string;
          id?: string;
          key_version?: number;
          snippet_enc?: string | null;
          source?: string;
          subject_enc?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          folder_id?: string;
          from_addr?: string | null;
          gmail_account_id?: string;
          gmail_message_id?: string;
          id?: string;
          key_version?: number;
          snippet_enc?: string | null;
          source?: string;
          subject_enc?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "folder_examples_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "folder_examples_gmail_account_id_fkey";
            columns: ["gmail_account_id"];
            isOneToOne: false;
            referencedRelation: "gmail_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      folder_filters: {
        Row: {
          created_at: string;
          field: string;
          folder_id: string;
          id: string;
          op: string;
          value: string;
        };
        Insert: {
          created_at?: string;
          field: string;
          folder_id: string;
          id?: string;
          op: string;
          value: string;
        };
        Update: {
          created_at?: string;
          field?: string;
          folder_id?: string;
          id?: string;
          op?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "folder_filters_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "folders";
            referencedColumns: ["id"];
          },
        ];
      };
      folder_retry_alerts: {
        Row: {
          fired_at: string;
          folder_id: string | null;
          id: string;
          retry_count: number;
          window_minutes: number;
        };
        Insert: {
          fired_at?: string;
          folder_id?: string | null;
          id?: string;
          retry_count: number;
          window_minutes: number;
        };
        Update: {
          fired_at?: string;
          folder_id?: string | null;
          id?: string;
          retry_count?: number;
          window_minutes?: number;
        };
        Relationships: [];
      };
      folder_summary_jobs: {
        Row: {
          created_at: string;
          emails_count: number | null;
          error: string | null;
          finished_at: string | null;
          id: string;
          locked_at: string | null;
          schedule_id: string;
          started_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          emails_count?: number | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          locked_at?: string | null;
          schedule_id: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          emails_count?: number | null;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          locked_at?: string | null;
          schedule_id?: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      folder_summary_schedules: {
        Row: {
          created_at: string;
          enabled: boolean;
          folder_id: string;
          gmail_account_id: string;
          hour: number;
          id: string;
          instructions: string;
          last_error: string | null;
          last_run_at: string | null;
          minute: number;
          name: string;
          next_run_at: string;
          timezone: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          enabled?: boolean;
          folder_id: string;
          gmail_account_id: string;
          hour: number;
          id?: string;
          instructions?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          minute: number;
          name: string;
          next_run_at: string;
          timezone?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          folder_id?: string;
          gmail_account_id?: string;
          hour?: number;
          id?: string;
          instructions?: string;
          last_error?: string | null;
          last_run_at?: string | null;
          minute?: number;
          name?: string;
          next_run_at?: string;
          timezone?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      folder_write_alerts: {
        Row: {
          error_code: string;
          failure_count: number;
          fired_at: string;
          folder_id: string | null;
          id: string;
          window_minutes: number;
        };
        Insert: {
          error_code: string;
          failure_count: number;
          fired_at?: string;
          folder_id?: string | null;
          id?: string;
          window_minutes: number;
        };
        Update: {
          error_code?: string;
          failure_count?: number;
          fired_at?: string;
          folder_id?: string | null;
          id?: string;
          window_minutes?: number;
        };
        Relationships: [];
      };
      folder_write_failures: {
        Row: {
          correlation_id: string | null;
          error_code: string | null;
          folder_id: string | null;
          gmail_account_id: string | null;
          id: string;
          occurred_at: string;
          source: string | null;
          user_id: string | null;
        };
        Insert: {
          correlation_id?: string | null;
          error_code?: string | null;
          folder_id?: string | null;
          gmail_account_id?: string | null;
          id?: string;
          occurred_at?: string;
          source?: string | null;
          user_id?: string | null;
        };
        Update: {
          correlation_id?: string | null;
          error_code?: string | null;
          folder_id?: string | null;
          gmail_account_id?: string | null;
          id?: string;
          occurred_at?: string;
          source?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      folder_write_retries: {
        Row: {
          attempts: number;
          correlation_id: string | null;
          error_code: string | null;
          folder_id: string | null;
          gmail_account_id: string | null;
          id: string;
          occurred_at: string;
          outcome: string;
          source: string | null;
          user_id: string | null;
        };
        Insert: {
          attempts: number;
          correlation_id?: string | null;
          error_code?: string | null;
          folder_id?: string | null;
          gmail_account_id?: string | null;
          id?: string;
          occurred_at?: string;
          outcome: string;
          source?: string | null;
          user_id?: string | null;
        };
        Update: {
          attempts?: number;
          correlation_id?: string | null;
          error_code?: string | null;
          folder_id?: string | null;
          gmail_account_id?: string | null;
          id?: string;
          occurred_at?: string;
          outcome?: string;
          source?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      folders: {
        Row: {
          ai_rule: string | null;
          auto_archive: boolean;
          auto_mark_read: boolean;
          auto_relearn: boolean;
          auto_star: boolean;
          color: string;
          created_at: string;
          emails_since_learn: number;
          filter_logic: string;
          filter_tree: Json | null;
          forward_to: string | null;
          gmail_account_id: string;
          gmail_backfill_oldest_received_at: string | null;
          gmail_backfill_page_token: string | null;
          gmail_label_id: string | null;
          hide_from_inbox: boolean;
          id: string;
          is_cold_email: boolean;
          last_learned_at: string | null;
          learned_profile: string | null;
          min_ai_confidence: number;
          name: string;
          overrides_inbox_override: boolean;
          priority: number;
          relearn_threshold: number;
          skip_ai: boolean;
          snooze_hours: number;
          surface_ai_rule: string | null;
          surface_names: string | null;
          user_id: string;
        };
        Insert: {
          ai_rule?: string | null;
          auto_archive?: boolean;
          auto_mark_read?: boolean;
          auto_relearn?: boolean;
          auto_star?: boolean;
          color?: string;
          created_at?: string;
          emails_since_learn?: number;
          filter_logic?: string;
          filter_tree?: Json | null;
          forward_to?: string | null;
          gmail_account_id: string;
          gmail_backfill_oldest_received_at?: string | null;
          gmail_backfill_page_token?: string | null;
          gmail_label_id?: string | null;
          hide_from_inbox?: boolean;
          id?: string;
          is_cold_email?: boolean;
          last_learned_at?: string | null;
          learned_profile?: string | null;
          min_ai_confidence?: number;
          name: string;
          overrides_inbox_override?: boolean;
          priority?: number;
          relearn_threshold?: number;
          skip_ai?: boolean;
          snooze_hours?: number;
          surface_ai_rule?: string | null;
          surface_names?: string | null;
          user_id: string;
        };
        Update: {
          ai_rule?: string | null;
          auto_archive?: boolean;
          auto_mark_read?: boolean;
          auto_relearn?: boolean;
          auto_star?: boolean;
          color?: string;
          created_at?: string;
          emails_since_learn?: number;
          filter_logic?: string;
          filter_tree?: Json | null;
          forward_to?: string | null;
          gmail_account_id?: string;
          gmail_backfill_oldest_received_at?: string | null;
          gmail_backfill_page_token?: string | null;
          gmail_label_id?: string | null;
          hide_from_inbox?: boolean;
          id?: string;
          is_cold_email?: boolean;
          last_learned_at?: string | null;
          learned_profile?: string | null;
          min_ai_confidence?: number;
          name?: string;
          overrides_inbox_override?: boolean;
          priority?: number;
          relearn_threshold?: number;
          skip_ai?: boolean;
          snooze_hours?: number;
          surface_ai_rule?: string | null;
          surface_names?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "folders_gmail_account_id_fkey";
            columns: ["gmail_account_id"];
            isOneToOne: false;
            referencedRelation: "gmail_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      game_scores: {
        Row: {
          achievements: string[];
          created_at: string;
          daily_seed: string | null;
          display_name: string;
          duration_ms: number;
          game: string;
          id: string;
          kills: number;
          level: number;
          max_combo: number;
          score: number;
          user_id: string;
        };
        Insert: {
          achievements?: string[];
          created_at?: string;
          daily_seed?: string | null;
          display_name: string;
          duration_ms?: number;
          game?: string;
          id?: string;
          kills?: number;
          level?: number;
          max_combo?: number;
          score: number;
          user_id: string;
        };
        Update: {
          achievements?: string[];
          created_at?: string;
          daily_seed?: string | null;
          display_name?: string;
          duration_ms?: number;
          game?: string;
          id?: string;
          kills?: number;
          level?: number;
          max_combo?: number;
          score?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      gmail_accounts: {
        Row: {
          access_token_enc: string | null;
          auto_record_meetings: boolean;
          calendar_access: boolean;
          calendar_guard_enabled: boolean;
          calendar_sync_error: string | null;
          calendar_synced_at: string | null;
          consecutive_silent_ticks: number;
          created_at: string;
          email_address: string;
          history_id: string | null;
          id: string;
          last_history_sync_at: string | null;
          last_oauth_error: string | null;
          last_poll_at: string | null;
          last_push_at: string | null;
          last_reconcile_at: string | null;
          needs_reconnect: boolean;
          reconcile_cursor: string | null;
          record_declined_meetings: boolean;
          refresh_token_enc: string | null;
          token_expires_at: string;
          updated_at: string;
          user_id: string;
          watch_expiration: string | null;
        };
        Insert: {
          access_token_enc?: string | null;
          auto_record_meetings?: boolean;
          calendar_access?: boolean;
          calendar_guard_enabled?: boolean;
          calendar_sync_error?: string | null;
          calendar_synced_at?: string | null;
          consecutive_silent_ticks?: number;
          created_at?: string;
          email_address: string;
          history_id?: string | null;
          id?: string;
          last_history_sync_at?: string | null;
          last_oauth_error?: string | null;
          last_poll_at?: string | null;
          last_push_at?: string | null;
          last_reconcile_at?: string | null;
          needs_reconnect?: boolean;
          reconcile_cursor?: string | null;
          record_declined_meetings?: boolean;
          refresh_token_enc?: string | null;
          token_expires_at: string;
          updated_at?: string;
          user_id: string;
          watch_expiration?: string | null;
        };
        Update: {
          access_token_enc?: string | null;
          auto_record_meetings?: boolean;
          calendar_access?: boolean;
          calendar_guard_enabled?: boolean;
          calendar_sync_error?: string | null;
          calendar_synced_at?: string | null;
          consecutive_silent_ticks?: number;
          created_at?: string;
          email_address?: string;
          history_id?: string | null;
          id?: string;
          last_history_sync_at?: string | null;
          last_oauth_error?: string | null;
          last_poll_at?: string | null;
          last_push_at?: string | null;
          last_reconcile_at?: string | null;
          needs_reconnect?: boolean;
          reconcile_cursor?: string | null;
          record_declined_meetings?: boolean;
          refresh_token_enc?: string | null;
          token_expires_at?: string;
          updated_at?: string;
          user_id?: string;
          watch_expiration?: string | null;
        };
        Relationships: [];
      };
      inbox_override_exceptions: {
        Row: {
          created_at: string;
          field: string;
          id: string;
          op: string;
          override_id: string;
          user_id: string;
          value: string;
        };
        Insert: {
          created_at?: string;
          field: string;
          id?: string;
          op: string;
          override_id: string;
          user_id: string;
          value: string;
        };
        Update: {
          created_at?: string;
          field?: string;
          id?: string;
          op?: string;
          override_id?: string;
          user_id?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "inbox_override_exceptions_override_id_fkey";
            columns: ["override_id"];
            isOneToOne: false;
            referencedRelation: "inbox_overrides";
            referencedColumns: ["id"];
          },
        ];
      };
      inbox_overrides: {
        Row: {
          created_at: string;
          gmail_account_id: string | null;
          id: string;
          match_type: string;
          note: string | null;
          user_id: string;
          value: string;
        };
        Insert: {
          created_at?: string;
          gmail_account_id?: string | null;
          id?: string;
          match_type: string;
          note?: string | null;
          user_id: string;
          value: string;
        };
        Update: {
          created_at?: string;
          gmail_account_id?: string | null;
          id?: string;
          match_type?: string;
          note?: string | null;
          user_id?: string;
          value?: string;
        };
        Relationships: [];
      };
      meeting_autojoin_exclusions: {
        Row: {
          calendar_event_id: string;
          created_at: string;
          gmail_account_id: string;
          id: string;
          user_id: string;
        };
        Insert: {
          calendar_event_id: string;
          created_at?: string;
          gmail_account_id: string;
          id?: string;
          user_id: string;
        };
        Update: {
          calendar_event_id?: string;
          created_at?: string;
          gmail_account_id?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "meeting_autojoin_exclusions_gmail_account_id_fkey";
            columns: ["gmail_account_id"];
            isOneToOne: false;
            referencedRelation: "gmail_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      meeting_bot_settings: {
        Row: {
          avatar_updated_at: string | null;
          bot_name: string;
          chat_message: string;
          chat_resend_on_join: boolean;
          created_at: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_updated_at?: string | null;
          bot_name?: string;
          chat_message?: string;
          chat_resend_on_join?: boolean;
          created_at?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_updated_at?: string | null;
          bot_name?: string;
          chat_message?: string;
          chat_resend_on_join?: boolean;
          created_at?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      meeting_participants: {
        Row: {
          contact_id: string | null;
          created_at: string;
          email: string | null;
          id: string;
          meeting_id: string;
          name: string | null;
        };
        Insert: {
          contact_id?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          meeting_id: string;
          name?: string | null;
        };
        Update: {
          contact_id?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          meeting_id?: string;
          name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "meeting_participants_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "meeting_participants_meeting_id_fkey";
            columns: ["meeting_id"];
            isOneToOne: false;
            referencedRelation: "meetings";
            referencedColumns: ["id"];
          },
        ];
      };
      meeting_record_blocklist: {
        Row: {
          created_at: string;
          id: string;
          user_id: string;
          value: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          user_id: string;
          value: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          user_id?: string;
          value?: string;
        };
        Relationships: [];
      };
      meetings: {
        Row: {
          audio_storage_path: string | null;
          calendar_event_id: string | null;
          created_at: string;
          ended_at: string | null;
          error: string | null;
          gmail_account_id: string | null;
          id: string;
          meeting_url: string | null;
          platform: string | null;
          recall_bot_id: string | null;
          recording_url: string | null;
          scheduled_start: string | null;
          source: Database["public"]["Enums"]["meeting_source"];
          started_at: string | null;
          status: Database["public"]["Enums"]["meeting_status"];
          summary: string | null;
          title: string | null;
          transcript: Json | null;
          updated_at: string;
          user_id: string;
          video_storage_path: string | null;
        };
        Insert: {
          audio_storage_path?: string | null;
          calendar_event_id?: string | null;
          created_at?: string;
          ended_at?: string | null;
          error?: string | null;
          gmail_account_id?: string | null;
          id?: string;
          meeting_url?: string | null;
          platform?: string | null;
          recall_bot_id?: string | null;
          recording_url?: string | null;
          scheduled_start?: string | null;
          source?: Database["public"]["Enums"]["meeting_source"];
          started_at?: string | null;
          status?: Database["public"]["Enums"]["meeting_status"];
          summary?: string | null;
          title?: string | null;
          transcript?: Json | null;
          updated_at?: string;
          user_id: string;
          video_storage_path?: string | null;
        };
        Update: {
          audio_storage_path?: string | null;
          calendar_event_id?: string | null;
          created_at?: string;
          ended_at?: string | null;
          error?: string | null;
          gmail_account_id?: string | null;
          id?: string;
          meeting_url?: string | null;
          platform?: string | null;
          recall_bot_id?: string | null;
          recording_url?: string | null;
          scheduled_start?: string | null;
          source?: Database["public"]["Enums"]["meeting_source"];
          started_at?: string | null;
          status?: Database["public"]["Enums"]["meeting_status"];
          summary?: string | null;
          title?: string | null;
          transcript?: Json | null;
          updated_at?: string;
          user_id?: string;
          video_storage_path?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "meetings_gmail_account_id_fkey";
            columns: ["gmail_account_id"];
            isOneToOne: false;
            referencedRelation: "gmail_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      message_jobs: {
        Row: {
          attempt: number;
          created_at: string;
          from_addr: string | null;
          gmail_account_id: string;
          gmail_message_id: string;
          id: string;
          last_error: string | null;
          locked_at: string | null;
          next_run_at: string;
          priority: number;
          published_at_ms: number | null;
          status: string;
          subject: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          attempt?: number;
          created_at?: string;
          from_addr?: string | null;
          gmail_account_id: string;
          gmail_message_id: string;
          id?: string;
          last_error?: string | null;
          locked_at?: string | null;
          next_run_at?: string;
          priority?: number;
          published_at_ms?: number | null;
          status?: string;
          subject?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          attempt?: number;
          created_at?: string;
          from_addr?: string | null;
          gmail_account_id?: string;
          gmail_message_id?: string;
          id?: string;
          last_error?: string | null;
          locked_at?: string | null;
          next_run_at?: string;
          priority?: number;
          published_at_ms?: number | null;
          status?: string;
          subject?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      my_cards: {
        Row: {
          avatar_url: string | null;
          company: string | null;
          cover_url: string | null;
          created_at: string;
          email: string | null;
          handle: string;
          id: string;
          linkedin: string | null;
          name: string | null;
          phone: string | null;
          tagline: string | null;
          theme: string;
          title: string | null;
          twitter: string | null;
          updated_at: string;
          user_id: string;
          website: string | null;
        };
        Insert: {
          avatar_url?: string | null;
          company?: string | null;
          cover_url?: string | null;
          created_at?: string;
          email?: string | null;
          handle: string;
          id?: string;
          linkedin?: string | null;
          name?: string | null;
          phone?: string | null;
          tagline?: string | null;
          theme?: string;
          title?: string | null;
          twitter?: string | null;
          updated_at?: string;
          user_id: string;
          website?: string | null;
        };
        Update: {
          avatar_url?: string | null;
          company?: string | null;
          cover_url?: string | null;
          created_at?: string;
          email?: string | null;
          handle?: string;
          id?: string;
          linkedin?: string | null;
          name?: string | null;
          phone?: string | null;
          tagline?: string | null;
          theme?: string;
          title?: string | null;
          twitter?: string | null;
          updated_at?: string;
          user_id?: string;
          website?: string | null;
        };
        Relationships: [];
      };
      pubsub_events: {
        Row: {
          accounts_matched: number | null;
          details: string | null;
          email_address: string | null;
          error: string | null;
          event_type: string;
          history_id: string | null;
          id: string;
          latency_ms: number | null;
          message_id: string | null;
          payload: Json | null;
          publish_time: string | null;
          received_at: string;
          subscription: string | null;
          synced_count: number | null;
        };
        Insert: {
          accounts_matched?: number | null;
          details?: string | null;
          email_address?: string | null;
          error?: string | null;
          event_type?: string;
          history_id?: string | null;
          id?: string;
          latency_ms?: number | null;
          message_id?: string | null;
          payload?: Json | null;
          publish_time?: string | null;
          received_at?: string;
          subscription?: string | null;
          synced_count?: number | null;
        };
        Update: {
          accounts_matched?: number | null;
          details?: string | null;
          email_address?: string | null;
          error?: string | null;
          event_type?: string;
          history_id?: string | null;
          id?: string;
          latency_ms?: number | null;
          message_id?: string | null;
          payload?: Json | null;
          publish_time?: string | null;
          received_at?: string;
          subscription?: string | null;
          synced_count?: number | null;
        };
        Relationships: [];
      };
      reply_drafts: {
        Row: {
          created_at: string;
          draft_text_enc: string | null;
          email_id: string;
          id: string;
          key_version: number;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          draft_text_enc?: string | null;
          email_id: string;
          id?: string;
          key_version?: number;
          user_id: string;
        };
        Update: {
          created_at?: string;
          draft_text_enc?: string | null;
          email_id?: string;
          id?: string;
          key_version?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reply_drafts_email_id_fkey";
            columns: ["email_id"];
            isOneToOne: false;
            referencedRelation: "emails";
            referencedColumns: ["id"];
          },
        ];
      };
      sync_state: {
        Row: {
          id: number;
          last_history_id: string | null;
          last_poll_at: string | null;
          updated_at: string;
          user_id: string;
          watch_expiration: string | null;
        };
        Insert: {
          id?: number;
          last_history_id?: string | null;
          last_poll_at?: string | null;
          updated_at?: string;
          user_id: string;
          watch_expiration?: string | null;
        };
        Update: {
          id?: number;
          last_history_id?: string | null;
          last_poll_at?: string | null;
          updated_at?: string;
          user_id?: string;
          watch_expiration?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      admin_daily_activity: {
        Args: { p_days?: number };
        Returns: {
          day: string;
          emails: number;
          signups: number;
        }[];
      };
      admin_user_stats: {
        Args: never;
        Returns: {
          contact_count: number;
          email_count: number;
          folder_count: number;
          jobs_dlq: number;
          jobs_pending: number;
          jobs_running: number;
          user_id: string;
        }[];
      };
      build_participant_tsv: {
        Args: { p_from_addr: string; p_from_name: string; p_to_addrs: string };
        Returns: unknown;
      };
      build_weighted_tsquery: {
        Args: { p_text: string; p_weight: string };
        Returns: unknown;
      };
      bump_history_id_if_greater: {
        Args: {
          p_account_id: string;
          p_new_history_id: string;
          p_watch_expiration?: string;
        };
        Returns: boolean;
      };
      claim_folder_summary_jobs: {
        Args: { p_limit?: number };
        Returns: {
          id: string;
          schedule_id: string;
          user_id: string;
        }[];
      };
      claim_forward_retries_v2: {
        Args: { p_key: string; p_limit: number };
        Returns: {
          body_text: string;
          folder_id: string;
          forward_attempts: number;
          from_addr: string;
          from_name: string;
          gmail_account_id: string;
          gmail_message_id: string;
          id: string;
          received_at: string;
          snippet: string;
          subject: string;
        }[];
      };
      claim_message_jobs: {
        Args: { p_limit: number; p_priority?: number };
        Returns: {
          attempt: number;
          gmail_account_id: string;
          gmail_message_id: string;
          id: string;
          priority: number;
          published_at_ms: number;
          user_id: string;
        }[];
      };
      cleanup_old_dlq_jobs: {
        Args: { p_batch_limit?: number; p_keep_days?: number };
        Returns: {
          deleted: number;
          total_before: number;
        }[];
      };
      cleanup_old_pubsub_events: {
        Args: {
          p_batch_limit?: number;
          p_keep_days?: number;
          p_keep_errors_days?: number;
        };
        Returns: {
          deleted: number;
          kept_errors: number;
          total_before: number;
        }[];
      };
      cron_secret_matches: { Args: { provided: string }; Returns: boolean };
      delete_gmail_account_content: {
        Args: { p_account_id: string; p_user_id: string };
        Returns: number;
      };
      get_contact_decrypted: {
        Args: { p_contact_id: string; p_key: string };
        Returns: {
          address_line1: string;
          address_line2: string;
          avatar_url: string;
          card_image_url: string;
          city: string;
          company: string;
          country: string;
          created_at: string;
          email: string;
          enriched_at: string;
          id: string;
          linkedin: string;
          name: string;
          notes: string;
          phone: string;
          postal_code: string;
          region: string;
          relationship_summary: string;
          source: string;
          summary_generated_at: string;
          title: string;
          twitter: string;
          updated_at: string;
          user_id: string;
          website: string;
        }[];
      };
      get_contacts_list_fields_decrypted: {
        Args: { p_ids: string[]; p_key: string };
        Returns: {
          id: string;
          phone: string;
          relationship_summary: string;
        }[];
      };
      get_emails_decrypted: {
        Args: { p_ids: string[]; p_key: string };
        Returns: {
          ai_confidence: number;
          ai_summary: string;
          body_html: string;
          body_text: string;
          cc: string;
          classification_reason: string;
          classified_by: string;
          created_at: string;
          folder_id: string;
          forwarded_at: string;
          forwarded_to: string;
          from_addr: string;
          from_name: string;
          gmail_account_id: string;
          gmail_message_id: string;
          has_attachment: boolean;
          id: string;
          in_reply_to: string;
          is_archived: boolean;
          is_read: boolean;
          list_id: string;
          matched_filter_ids: string[];
          matched_folder_ids: string[];
          processed_at: string;
          published_at_ms: number;
          raw_labels: string[];
          received_at: string;
          snippet: string;
          snoozed_until: string;
          subject: string;
          thread_id: string;
          to_addrs: string;
          user_id: string;
        }[];
      };
      get_emails_list_decrypted: {
        Args: {
          p_account_id: string;
          p_cursor: string;
          p_folder_id: string;
          p_key: string;
          p_limit: number;
          p_scope: string;
          p_user_id: string;
        };
        Returns: {
          ai_confidence: number;
          ai_summary: string;
          classification_reason: string;
          classified_by: string;
          folder_id: string;
          from_addr: string;
          from_name: string;
          gmail_message_id: string;
          has_attachment: boolean;
          id: string;
          is_archived: boolean;
          is_read: boolean;
          matched_filter_ids: string[];
          matched_folder_ids: string[];
          processed_at: string;
          raw_labels: string[];
          received_at: string;
          snippet: string;
          snoozed_until: string;
          subject: string;
          surfaced_to_inbox: boolean;
          thread_id: string;
          to_addrs: string;
        }[];
      };
      get_emails_list_fields_decrypted: {
        Args: { p_ids: string[]; p_key: string };
        Returns: {
          ai_summary: string;
          cc: string;
          classification_reason: string;
          from_name: string;
          id: string;
          snippet: string;
          subject: string;
          to_addrs: string;
        }[];
      };
      get_folder_examples_decrypted: {
        Args: { p_folder_id: string; p_key: string };
        Returns: {
          created_at: string;
          folder_id: string;
          from_addr: string;
          gmail_account_id: string;
          gmail_message_id: string;
          id: string;
          snippet: string;
          source: string;
          subject: string;
          user_id: string;
        }[];
      };
      get_folder_unread_counts: {
        Args: { p_account_id: string };
        Returns: Json;
      };
      get_gmail_oauth_tokens: {
        Args: { p_account_id: string; p_key: string };
        Returns: {
          access_token: string;
          refresh_token: string;
          token_expires_at: string;
        }[];
      };
      get_invader_stats: { Args: never; Returns: Json };
      get_reply_draft_decrypted: {
        Args: { p_email_id: string; p_key: string };
        Returns: {
          created_at: string;
          draft_text: string;
          email_id: string;
          id: string;
          user_id: string;
        }[];
      };
      get_sync_latency_stats:
        | {
            Args: { p_lookback_hours?: number; p_user_id: string };
            Returns: Json;
          }
        | {
            Args: {
              p_account_id?: string;
              p_lookback_hours?: number;
              p_user_id: string;
            };
            Returns: Json;
          };
      increment_emails_since_learn: {
        Args: { p_folder_id: string };
        Returns: undefined;
      };
      insert_email_encrypted: {
        Args: {
          p_body_html: string;
          p_body_text: string;
          p_cc: string;
          p_from_addr: string;
          p_from_name: string;
          p_gmail_account_id: string;
          p_gmail_message_id: string;
          p_has_attachment: boolean;
          p_in_reply_to: string;
          p_key: string;
          p_list_id: string;
          p_published_at_ms: number;
          p_raw_labels: string[];
          p_received_at: string;
          p_snippet: string;
          p_subject: string;
          p_thread_id: string;
          p_to_addrs: string;
          p_user_id: string;
        };
        Returns: string;
      };
      insert_folder_example_encrypted: {
        Args: {
          p_folder_id: string;
          p_from_addr: string;
          p_gmail_account_id: string;
          p_gmail_message_id: string;
          p_key: string;
          p_snippet: string;
          p_source: string;
          p_subject: string;
          p_user_id: string;
        };
        Returns: string;
      };
      list_decryption_audit: {
        Args: { p_limit?: number };
        Returns: {
          caller: string;
          id: string;
          kind: string;
          occurred_at: string;
          row_id: string;
          success: boolean;
        }[];
      };
      list_my_gmail_accounts_with_status: {
        Args: never;
        Returns: {
          created_at: string;
          email_address: string;
          history_id: string;
          id: string;
          last_poll_at: string;
          refresh_token_present: boolean;
          watch_expiration: string;
        }[];
      };
      reindex_email_participants: {
        Args: { p_batch_limit: number; p_key: string };
        Returns: number;
      };
      reindex_email_search_sender: {
        Args: { p_batch_limit: number; p_key: string };
        Returns: number;
      };
      search_emails: {
        Args: {
          p_account_id?: string;
          p_key: string;
          p_limit: number;
          p_offset: number;
          p_query: string;
          p_user_id: string;
        };
        Returns: {
          folder_id: string;
          from_addr: string;
          from_name: string;
          gmail_account_id: string;
          gmail_message_id: string;
          id: string;
          is_archived: boolean;
          is_read: boolean;
          rank: number;
          received_at: string;
          snippet: string;
          subject: string;
          thread_id: string;
        }[];
      };
      search_emails_participants: {
        Args: {
          p_account_id?: string;
          p_from: string;
          p_key: string;
          p_limit: number;
          p_offset: number;
          p_rest: string;
          p_to: string;
          p_user_id: string;
        };
        Returns: {
          folder_id: string;
          from_addr: string;
          from_name: string;
          gmail_account_id: string;
          gmail_message_id: string;
          id: string;
          is_archived: boolean;
          is_read: boolean;
          rank: number;
          received_at: string;
          snippet: string;
          subject: string;
          thread_id: string;
        }[];
      };
      set_contact_encrypted_fields: {
        Args: {
          p_address_line1: string;
          p_address_line2: string;
          p_contact_id: string;
          p_key: string;
          p_notes: string;
          p_phone: string;
          p_relationship_summary: string;
        };
        Returns: undefined;
      };
      set_gmail_oauth_tokens: {
        Args: {
          p_access_token: string;
          p_account_id: string;
          p_key: string;
          p_refresh_token: string;
          p_token_expires_at: string;
        };
        Returns: undefined;
      };
      set_reply_draft_encrypted: {
        Args: {
          p_draft_text: string;
          p_email_id: string;
          p_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      update_email_encrypted: {
        Args: {
          p_ai_confidence: number;
          p_ai_summary: string;
          p_body_html: string;
          p_body_text: string;
          p_classification_reason: string;
          p_classified_by: string;
          p_email_id: string;
          p_folder_id: string;
          p_from_name: string;
          p_key: string;
          p_matched_filter_ids: string[];
          p_matched_folder_ids: string[];
          p_snippet: string;
          p_subject: string;
          p_to_addrs: string;
        };
        Returns: undefined;
      };
      upsert_email_encrypted: {
        Args: {
          p_body_html: string;
          p_body_text: string;
          p_cc: string;
          p_classified_by: string;
          p_from_addr: string;
          p_from_name: string;
          p_gmail_account_id: string;
          p_gmail_message_id: string;
          p_has_attachment: boolean;
          p_in_reply_to: string;
          p_is_archived: boolean;
          p_is_read: boolean;
          p_key: string;
          p_list_id: string;
          p_processed_at: string;
          p_published_at_ms: number;
          p_raw_labels: string[];
          p_received_at: string;
          p_snippet: string;
          p_subject: string;
          p_thread_id: string;
          p_to_addrs: string;
          p_user_id: string;
        };
        Returns: string;
      };
      upsert_gmail_oauth_account: {
        Args: {
          p_access_token: string;
          p_email_address: string;
          p_key: string;
          p_refresh_token: string;
          p_token_expires_at: string;
          p_user_id: string;
        };
        Returns: string;
      };
    };
    Enums: {
      meeting_source: "link" | "calendar" | "in_person";
      meeting_status: "scheduled" | "joining" | "recording" | "done" | "failed" | "processing";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      meeting_source: ["link", "calendar", "in_person"],
      meeting_status: ["scheduled", "joining", "recording", "done", "failed", "processing"],
    },
  },
} as const;
