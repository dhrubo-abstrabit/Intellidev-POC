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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      action_item_source_events: {
        Row: {
          action_item_id: string
          client_space_id: string
          normalized_event_id: string
          relevance: number | null
        }
        Insert: {
          action_item_id: string
          client_space_id: string
          normalized_event_id: string
          relevance?: number | null
        }
        Update: {
          action_item_id?: string
          client_space_id?: string
          normalized_event_id?: string
          relevance?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "action_item_source_events_action_item_id_fkey"
            columns: ["action_item_id"]
            isOneToOne: false
            referencedRelation: "action_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_item_source_events_normalized_event_id_fkey"
            columns: ["normalized_event_id"]
            isOneToOne: false
            referencedRelation: "normalized_events"
            referencedColumns: ["id"]
          },
        ]
      }
      action_items: {
        Row: {
          assignee_id: string | null
          assignee_team_member_id: string | null
          client_space_id: string
          confidence_score: number
          created_at: string
          dedupe_hash: string
          description: string | null
          due_at: string | null
          for_date: string
          generated_at: string
          id: string
          kind: Database["public"]["Enums"]["action_item_kind"]
          llm_run_id: string | null
          owner_hint: string | null
          priority: Database["public"]["Enums"]["action_item_priority"]
          project_id: string | null
          resolved_at: string | null
          snoozed_until: string | null
          status: Database["public"]["Enums"]["action_item_status"]
          superseded_by: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          assignee_id?: string | null
          assignee_team_member_id?: string | null
          client_space_id: string
          confidence_score: number
          created_at?: string
          dedupe_hash: string
          description?: string | null
          due_at?: string | null
          for_date: string
          generated_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["action_item_kind"]
          llm_run_id?: string | null
          owner_hint?: string | null
          priority?: Database["public"]["Enums"]["action_item_priority"]
          project_id?: string | null
          resolved_at?: string | null
          snoozed_until?: string | null
          status?: Database["public"]["Enums"]["action_item_status"]
          superseded_by?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          assignee_id?: string | null
          assignee_team_member_id?: string | null
          client_space_id?: string
          confidence_score?: number
          created_at?: string
          dedupe_hash?: string
          description?: string | null
          due_at?: string | null
          for_date?: string
          generated_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["action_item_kind"]
          llm_run_id?: string | null
          owner_hint?: string | null
          priority?: Database["public"]["Enums"]["action_item_priority"]
          project_id?: string | null
          resolved_at?: string | null
          snoozed_until?: string | null
          status?: Database["public"]["Enums"]["action_item_status"]
          superseded_by?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_items_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_items_assignee_team_member_id_workspace_id_fkey"
            columns: ["assignee_team_member_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "action_items_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "action_items_llm_run_id_client_space_id_fkey"
            columns: ["llm_run_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "llm_runs"
            referencedColumns: ["id", "client_space_id"]
          },
          {
            foreignKeyName: "action_items_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
          },
          {
            foreignKeyName: "action_items_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "action_items"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_type: string
          actor_user_id: string | null
          client_space_id: string | null
          created_at: string
          id: number
          ip_address: unknown
          metadata: Json
          project_id: string | null
          target_id: string | null
          target_type: string | null
          tenant_id: string | null
          user_agent: string | null
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_type?: string
          actor_user_id?: string | null
          client_space_id?: string | null
          created_at?: string
          id?: never
          ip_address?: unknown
          metadata?: Json
          project_id?: string | null
          target_id?: string | null
          target_type?: string | null
          tenant_id?: string | null
          user_agent?: string | null
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_type?: string
          actor_user_id?: string | null
          client_space_id?: string | null
          created_at?: string
          id?: never
          ip_address?: unknown
          metadata?: Json
          project_id?: string | null
          target_id?: string | null
          target_type?: string | null
          tenant_id?: string | null
          user_agent?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_invoices: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          hosted_invoice_url: string | null
          id: string
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          stripe_invoice_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          hosted_invoice_url?: string | null
          id?: string
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_invoice_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          hosted_invoice_url?: string | null
          id?: string
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_invoice_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      client_spaces: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          logo_path: string | null
          name: string
          slug: string
          status: Database["public"]["Enums"]["client_space_status"]
          tenant_id: string
          timezone: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          logo_path?: string | null
          name: string
          slug: string
          status?: Database["public"]["Enums"]["client_space_status"]
          tenant_id: string
          timezone?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          logo_path?: string | null
          name?: string
          slug?: string
          status?: Database["public"]["Enums"]["client_space_status"]
          tenant_id?: string
          timezone?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_spaces_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_spaces_workspace_id_tenant_id_fkey"
            columns: ["workspace_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      connector_credentials: {
        Row: {
          access_token_expires_at: string | null
          client_space_id: string
          created_at: string
          created_by: string | null
          external_account_id: string
          external_account_label: string | null
          id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          refresh_failed_at: string | null
          refresh_failure_count: number
          revoked_at: string | null
          secret_alg: string
          secret_ciphertext: string
          secret_iv: string
          secret_key_version: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          access_token_expires_at?: string | null
          client_space_id: string
          created_at?: string
          created_by?: string | null
          external_account_id: string
          external_account_label?: string | null
          id?: string
          provider: Database["public"]["Enums"]["connector_provider"]
          refresh_failed_at?: string | null
          refresh_failure_count?: number
          revoked_at?: string | null
          secret_alg?: string
          secret_ciphertext: string
          secret_iv: string
          secret_key_version?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          access_token_expires_at?: string | null
          client_space_id?: string
          created_at?: string
          created_by?: string | null
          external_account_id?: string
          external_account_label?: string | null
          id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          refresh_failed_at?: string | null
          refresh_failure_count?: number
          revoked_at?: string | null
          secret_alg?: string
          secret_ciphertext?: string
          secret_iv?: string
          secret_key_version?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_credentials_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "connector_credentials_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_summaries: {
        Row: {
          client_space_id: string
          created_at: string
          headline: string | null
          highlights: Json
          id: string
          llm_run_id: string | null
          metrics: Json
          summary: string
          summary_date: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          client_space_id: string
          created_at?: string
          headline?: string | null
          highlights?: Json
          id?: string
          llm_run_id?: string | null
          metrics?: Json
          summary: string
          summary_date: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          client_space_id?: string
          created_at?: string
          headline?: string | null
          highlights?: Json
          id?: string
          llm_run_id?: string | null
          metrics?: Json
          summary?: string
          summary_date?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_summaries_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "daily_summaries_llm_run_id_client_space_id_fkey"
            columns: ["llm_run_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "llm_runs"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      event_attachments: {
        Row: {
          client_space_id: string
          created_at: string
          download_ref: Json
          error: string | null
          extracted_chars: number | null
          extracted_text: string | null
          filename: string | null
          id: string
          integration_id: string
          mime_type: string | null
          normalized_event_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_attachment_id: string
          size_bytes: number | null
          skip_reason: string | null
          status: string
          storage_path: string | null
          text_truncated: boolean
          updated_at: string
        }
        Insert: {
          client_space_id: string
          created_at?: string
          download_ref?: Json
          error?: string | null
          extracted_chars?: number | null
          extracted_text?: string | null
          filename?: string | null
          id: string
          integration_id: string
          mime_type?: string | null
          normalized_event_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_attachment_id: string
          size_bytes?: number | null
          skip_reason?: string | null
          status?: string
          storage_path?: string | null
          text_truncated?: boolean
          updated_at?: string
        }
        Update: {
          client_space_id?: string
          created_at?: string
          download_ref?: Json
          error?: string | null
          extracted_chars?: number | null
          extracted_text?: string | null
          filename?: string | null
          id?: string
          integration_id?: string
          mime_type?: string | null
          normalized_event_id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          provider_attachment_id?: string
          size_bytes?: number | null
          skip_reason?: string | null
          status?: string
          storage_path?: string | null
          text_truncated?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_attachments_integration_id_client_space_id_fkey"
            columns: ["integration_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "client_space_id"]
          },
          {
            foreignKeyName: "event_attachments_normalized_event_id_fkey"
            columns: ["normalized_event_id"]
            isOneToOne: false
            referencedRelation: "normalized_events"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_cursors: {
        Row: {
          created_at: string
          cursor: Json
          integration_id: string
          last_advanced_at: string
          scope_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          cursor: Json
          integration_id: string
          last_advanced_at?: string
          scope_key?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          cursor?: Json
          integration_id?: string
          last_advanced_at?: string
          scope_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_cursors_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          client_space_id: string
          config: Json
          connected_by: string | null
          consecutive_failures: number
          created_at: string
          credential_id: string | null
          display_name: string | null
          id: string
          last_error: string | null
          last_sync_started_at: string | null
          last_sync_succeeded_at: string | null
          next_sync_at: string
          provider: Database["public"]["Enums"]["connector_provider"]
          status: Database["public"]["Enums"]["integration_status"]
          sync_enabled: boolean
          sync_interval_seconds: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          client_space_id: string
          config?: Json
          connected_by?: string | null
          consecutive_failures?: number
          created_at?: string
          credential_id?: string | null
          display_name?: string | null
          id?: string
          last_error?: string | null
          last_sync_started_at?: string | null
          last_sync_succeeded_at?: string | null
          next_sync_at?: string
          provider: Database["public"]["Enums"]["connector_provider"]
          status?: Database["public"]["Enums"]["integration_status"]
          sync_enabled?: boolean
          sync_interval_seconds?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          client_space_id?: string
          config?: Json
          connected_by?: string | null
          consecutive_failures?: number
          created_at?: string
          credential_id?: string | null
          display_name?: string | null
          id?: string
          last_error?: string | null
          last_sync_started_at?: string | null
          last_sync_succeeded_at?: string | null
          next_sync_at?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          status?: Database["public"]["Enums"]["integration_status"]
          sync_enabled?: boolean
          sync_interval_seconds?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "integrations_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integrations_credential_id_client_space_id_fkey"
            columns: ["credential_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "connector_credentials"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      job_dispatches: {
        Row: {
          attempt: number
          dispatched_at: string
          error: string | null
          id: string
          msg_id: number
          request_id: number | null
          resolved_at: string | null
          route: string
          status_code: number | null
        }
        Insert: {
          attempt: number
          dispatched_at?: string
          error?: string | null
          id?: string
          msg_id: number
          request_id?: number | null
          resolved_at?: string | null
          route: string
          status_code?: number | null
        }
        Update: {
          attempt?: number
          dispatched_at?: string
          error?: string | null
          id?: string
          msg_id?: number
          request_id?: number | null
          resolved_at?: string | null
          route?: string
          status_code?: number | null
        }
        Relationships: []
      }
      llm_runs: {
        Row: {
          cache_creation_tokens: number | null
          cache_read_tokens: number | null
          client_space_id: string
          completion_tokens: number | null
          cost_usd: number | null
          created_at: string
          error_message: string | null
          finished_at: string | null
          id: string
          idempotency_key: string | null
          input_event_ids: string[]
          kind: Database["public"]["Enums"]["llm_run_kind"]
          latency_ms: number | null
          model: string
          prompt: Json | null
          prompt_tokens: number | null
          prompt_version: string
          provider: string
          response: Json | null
          started_at: string | null
          status: Database["public"]["Enums"]["llm_run_status"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          cache_creation_tokens?: number | null
          cache_read_tokens?: number | null
          client_space_id: string
          completion_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          input_event_ids?: string[]
          kind: Database["public"]["Enums"]["llm_run_kind"]
          latency_ms?: number | null
          model: string
          prompt?: Json | null
          prompt_tokens?: number | null
          prompt_version: string
          provider?: string
          response?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["llm_run_status"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          cache_creation_tokens?: number | null
          cache_read_tokens?: number | null
          client_space_id?: string
          completion_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          input_event_ids?: string[]
          kind?: Database["public"]["Enums"]["llm_run_kind"]
          latency_ms?: number | null
          model?: string
          prompt?: Json | null
          prompt_tokens?: number | null
          prompt_version?: string
          provider?: string
          response?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["llm_run_status"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_runs_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      milestones: {
        Row: {
          client_space_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          id: string
          position: number
          project_id: string | null
          status: Database["public"]["Enums"]["milestone_status"]
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          client_space_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          position?: number
          project_id?: string | null
          status?: Database["public"]["Enums"]["milestone_status"]
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          client_space_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          position?: number
          project_id?: string | null
          status?: Database["public"]["Enums"]["milestone_status"]
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "milestones_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "milestones_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestones_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      normalized_events: {
        Row: {
          actor: string | null
          actor_display: string | null
          actor_email: string | null
          body: string | null
          client_space_id: string
          dedupe_key: string
          id: string
          ingested_at: string
          integration_id: string
          metadata: Json
          occurred_at: string
          processed_at: string | null
          provider: Database["public"]["Enums"]["connector_provider"]
          raw_event_id: string | null
          resource: string | null
          resource_type: string | null
          resource_url: string | null
          title: string | null
          type: string
        }
        Insert: {
          actor?: string | null
          actor_display?: string | null
          actor_email?: string | null
          body?: string | null
          client_space_id: string
          dedupe_key: string
          id: string
          ingested_at?: string
          integration_id: string
          metadata?: Json
          occurred_at: string
          processed_at?: string | null
          provider: Database["public"]["Enums"]["connector_provider"]
          raw_event_id?: string | null
          resource?: string | null
          resource_type?: string | null
          resource_url?: string | null
          title?: string | null
          type: string
        }
        Update: {
          actor?: string | null
          actor_display?: string | null
          actor_email?: string | null
          body?: string | null
          client_space_id?: string
          dedupe_key?: string
          id?: string
          ingested_at?: string
          integration_id?: string
          metadata?: Json
          occurred_at?: string
          processed_at?: string | null
          provider?: Database["public"]["Enums"]["connector_provider"]
          raw_event_id?: string | null
          resource?: string | null
          resource_type?: string | null
          resource_url?: string | null
          title?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "normalized_events_integration_id_client_space_id_fkey"
            columns: ["integration_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      project_connector_scopes: {
        Row: {
          client_space_id: string
          created_at: string
          created_by: string | null
          integration_id: string
          project_id: string
        }
        Insert: {
          client_space_id: string
          created_at?: string
          created_by?: string | null
          integration_id: string
          project_id: string
        }
        Update: {
          client_space_id?: string
          created_at?: string
          created_by?: string | null
          integration_id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_connector_scopes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_connector_scopes_integration_id_client_space_id_fkey"
            columns: ["integration_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "client_space_id"]
          },
          {
            foreignKeyName: "project_connector_scopes_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      project_members: {
        Row: {
          added_by: string | null
          created_at: string
          project_id: string
          role: Database["public"]["Enums"]["project_role"] | null
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          project_id: string
          role?: Database["public"]["Enums"]["project_role"] | null
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          project_id?: string
          role?: Database["public"]["Enums"]["project_role"] | null
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "project_members_workspace_id_user_id_fkey"
            columns: ["workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["workspace_id", "user_id"]
          },
        ]
      }
      projects: {
        Row: {
          archived_at: string | null
          client_space_id: string
          context_docs: Json
          created_at: string
          created_by: string | null
          description: string | null
          health_score: number | null
          id: string
          name: string
          slug: string
          status: Database["public"]["Enums"]["project_status"]
          updated_at: string
          visibility: Database["public"]["Enums"]["project_visibility"]
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          client_space_id: string
          context_docs?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          health_score?: number | null
          id?: string
          name: string
          slug: string
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
          visibility?: Database["public"]["Enums"]["project_visibility"]
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          client_space_id?: string
          context_docs?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          health_score?: number | null
          id?: string
          name?: string
          slug?: string
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
          visibility?: Database["public"]["Enums"]["project_visibility"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_events: {
        Row: {
          client_space_id: string
          id: string
          ingested_at: string
          integration_id: string
          occurred_at: string | null
          payload: Json
          payload_hash: string | null
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_event_id: string | null
          sync_job_id: string | null
        }
        Insert: {
          client_space_id: string
          id: string
          ingested_at?: string
          integration_id: string
          occurred_at?: string | null
          payload: Json
          payload_hash?: string | null
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_event_id?: string | null
          sync_job_id?: string | null
        }
        Update: {
          client_space_id?: string
          id?: string
          ingested_at?: string
          integration_id?: string
          occurred_at?: string | null
          payload?: Json
          payload_hash?: string | null
          provider?: Database["public"]["Enums"]["connector_provider"]
          provider_event_id?: string | null
          sync_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_events_integration_id_client_space_id_fkey"
            columns: ["integration_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      sync_batch_members: {
        Row: {
          batch_id: string
          client_space_id: string
          completed_at: string | null
          created_at: string
          id: string
          integration_id: string
          outcome: string | null
        }
        Insert: {
          batch_id: string
          client_space_id: string
          completed_at?: string | null
          created_at?: string
          id?: string
          integration_id: string
          outcome?: string | null
        }
        Update: {
          batch_id?: string
          client_space_id?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          integration_id?: string
          outcome?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_batch_members_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "sync_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_batch_members_integration_id_client_space_id_fkey"
            columns: ["integration_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      sync_batches: {
        Row: {
          batch_date: string
          client_space_id: string
          created_at: string
          id: string
          llm_triggered_at: string | null
          workspace_id: string
        }
        Insert: {
          batch_date: string
          client_space_id: string
          created_at?: string
          id?: string
          llm_triggered_at?: string | null
          workspace_id: string
        }
        Update: {
          batch_date?: string
          client_space_id?: string
          created_at?: string
          id?: string
          llm_triggered_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_batches_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          attempt: number
          client_space_id: string
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_message: string | null
          events_fetched: number
          events_written: number
          finished_at: string | null
          id: string
          idempotency_key: string | null
          integration_id: string
          max_attempts: number
          qstash_message_id: string | null
          scheduled_for: string
          started_at: string | null
          status: Database["public"]["Enums"]["sync_job_status"]
          trigger: Database["public"]["Enums"]["sync_trigger"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt?: number
          client_space_id: string
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_message?: string | null
          events_fetched?: number
          events_written?: number
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          integration_id: string
          max_attempts?: number
          qstash_message_id?: string | null
          scheduled_for?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["sync_job_status"]
          trigger?: Database["public"]["Enums"]["sync_trigger"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt?: number
          client_space_id?: string
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_message?: string | null
          events_fetched?: number
          events_written?: number
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          integration_id?: string
          max_attempts?: number
          qstash_message_id?: string | null
          scheduled_for?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["sync_job_status"]
          trigger?: Database["public"]["Enums"]["sync_trigger"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_jobs_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "sync_jobs_integration_id_client_space_id_fkey"
            columns: ["integration_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      team_members: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          email: string
          id: string
          name: string
          role: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          email: string
          id?: string
          name: string
          role?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          email?: string
          id?: string
          name?: string
          role?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_admins: {
        Row: {
          created_at: string
          invited_by: string | null
          joined_at: string
          role: Database["public"]["Enums"]["tenant_admin_role"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["tenant_admin_role"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["tenant_admin_role"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_admins_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_admins_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_admins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          max_client_spaces: number | null
          max_members_per_ws: number | null
          max_projects: number | null
          max_workspaces: number | null
          plan: string
          status: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          tenant_id: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          max_client_spaces?: number | null
          max_members_per_ws?: number | null
          max_projects?: number | null
          max_workspaces?: number | null
          plan?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          max_client_spaces?: number | null
          max_members_per_ws?: number | null
          max_projects?: number | null
          max_workspaces?: number | null
          plan?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          domain: string | null
          id: string
          name: string
          owner_id: string
          settings: Json
          slug: string
          status: Database["public"]["Enums"]["tenant_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          domain?: string | null
          id?: string
          name: string
          owner_id: string
          settings?: Json
          slug: string
          status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          domain?: string | null
          id?: string
          name?: string
          owner_id?: string
          settings?: Json
          slug?: string
          status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenants_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_records: {
        Row: {
          api_calls: number
          created_at: string
          id: string
          llm_tokens_used: number
          storage_bytes: number
          sync_jobs_run: number
          tenant_id: string
          updated_at: string
          usage_date: string
        }
        Insert: {
          api_calls?: number
          created_at?: string
          id?: string
          llm_tokens_used?: number
          storage_bytes?: number
          sync_jobs_run?: number
          tenant_id: string
          updated_at?: string
          usage_date: string
        }
        Update: {
          api_calls?: number
          created_at?: string
          id?: string
          llm_tokens_used?: number
          storage_bytes?: number
          sync_jobs_run?: number
          tenant_id?: string
          updated_at?: string
          usage_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_records_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      workspace_members: {
        Row: {
          created_at: string
          invited_by: string | null
          joined_at: string
          role: Database["public"]["Enums"]["workspace_role"]
          tenant_id: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          tenant_id: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_tenant_id_fkey"
            columns: ["workspace_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          description: string | null
          id: string
          logo_path: string | null
          name: string
          owner_id: string
          slug: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          logo_path?: string | null
          name: string
          owner_id: string
          slug: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          logo_path?: string | null
          name?: string
          owner_id?: string
          slug?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspaces_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ack_job: { Args: { p_msg_id: number }; Returns: boolean }
      current_client_space_ids: { Args: never; Returns: string[] }
      current_project_ids: { Args: never; Returns: string[] }
      current_project_roles: {
        Args: never
        Returns: {
          project_id: string
          role: Database["public"]["Enums"]["project_role"]
        }[]
      }
      current_tenant_ids: { Args: never; Returns: string[] }
      current_workspace_ids: { Args: never; Returns: string[] }
      dispatch_daily_tick: { Args: never; Returns: undefined }
      dispatch_jobs: { Args: never; Returns: undefined }
      enqueue_job: {
        Args: { p_delay_seconds?: number; p_payload: Json; p_route: string }
        Returns: number
      }
      fail_job: {
        Args: { p_attempt: number; p_error: string; p_msg_id: number }
        Returns: boolean
      }
      has_tenant_role: {
        Args: {
          p_roles: Database["public"]["Enums"]["tenant_admin_role"][]
          p_tenant_id: string
        }
        Returns: boolean
      }
      has_workspace_role: {
        Args: {
          p_roles: Database["public"]["Enums"]["workspace_role"][]
          p_workspace_id: string
        }
        Returns: boolean
      }
      is_workspace_member: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      manageable_project_ids: { Args: never; Returns: string[] }
      prune_event_attachments: {
        Args: { p_older_than_days?: number }
        Returns: {
          deleted_objects: number
          deleted_rows: number
        }[]
      }
      reap_job_dispatches: { Args: never; Returns: undefined }
    }
    Enums: {
      action_item_kind: "action" | "risk" | "blocker" | "update" | "follow_up"
      action_item_priority: "low" | "medium" | "high" | "urgent"
      action_item_status:
        | "pending"
        | "in_progress"
        | "done"
        | "dismissed"
        | "snoozed"
      client_space_status: "active" | "archived"
      connector_provider:
        | "slack"
        | "google"
        | "gmail"
        | "google_drive"
        | "google_chat"
        | "clickup"
        | "mock"
      integration_status:
        | "pending"
        | "connected"
        | "degraded"
        | "error"
        | "revoked"
        | "disconnected"
      invoice_status: "draft" | "paid" | "failed" | "void"
      llm_run_kind: "action_items" | "daily_summary" | "backfill"
      llm_run_status: "queued" | "running" | "succeeded" | "failed"
      milestone_status:
        | "planned"
        | "in_progress"
        | "at_risk"
        | "done"
        | "cancelled"
      project_role: "manager" | "contributor" | "viewer"
      project_status: "active" | "paused" | "archived"
      project_visibility: "workspace" | "restricted"
      subscription_status: "trialing" | "active" | "past_due" | "cancelled"
      sync_job_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
      sync_trigger: "schedule" | "manual" | "webhook" | "backfill"
      tenant_admin_role: "super_admin" | "billing_admin"
      tenant_status: "active" | "suspended" | "cancelled"
      workspace_role: "owner" | "admin" | "member" | "viewer"
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
    Enums: {
      action_item_kind: ["action", "risk", "blocker", "update", "follow_up"],
      action_item_priority: ["low", "medium", "high", "urgent"],
      action_item_status: [
        "pending",
        "in_progress",
        "done",
        "dismissed",
        "snoozed",
      ],
      client_space_status: ["active", "archived"],
      connector_provider: [
        "slack",
        "google",
        "gmail",
        "google_drive",
        "google_chat",
        "clickup",
        "mock",
      ],
      integration_status: [
        "pending",
        "connected",
        "degraded",
        "error",
        "revoked",
        "disconnected",
      ],
      invoice_status: ["draft", "paid", "failed", "void"],
      llm_run_kind: ["action_items", "daily_summary", "backfill"],
      llm_run_status: ["queued", "running", "succeeded", "failed"],
      milestone_status: [
        "planned",
        "in_progress",
        "at_risk",
        "done",
        "cancelled",
      ],
      project_role: ["manager", "contributor", "viewer"],
      project_status: ["active", "paused", "archived"],
      project_visibility: ["workspace", "restricted"],
      subscription_status: ["trialing", "active", "past_due", "cancelled"],
      sync_job_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
      ],
      sync_trigger: ["schedule", "manual", "webhook", "backfill"],
      tenant_admin_role: ["super_admin", "billing_admin"],
      tenant_status: ["active", "suspended", "cancelled"],
      workspace_role: ["owner", "admin", "member", "viewer"],
    },
  },
} as const
