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
          normalized_event_id: string
          relevance: number | null
          workspace_id: string
        }
        Insert: {
          action_item_id: string
          normalized_event_id: string
          relevance?: number | null
          workspace_id: string
        }
        Update: {
          action_item_id?: string
          normalized_event_id?: string
          relevance?: number | null
          workspace_id?: string
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
          project_id: string
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
          project_id: string
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
          project_id?: string
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
            foreignKeyName: "action_items_llm_run_id_workspace_id_fkey"
            columns: ["llm_run_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "llm_runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "action_items_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
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
          created_at: string
          id: number
          ip_address: unknown
          metadata: Json
          project_id: string | null
          target_id: string | null
          target_type: string | null
          user_agent: string | null
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_type?: string
          actor_user_id?: string | null
          created_at?: string
          id?: never
          ip_address?: unknown
          metadata?: Json
          project_id?: string | null
          target_id?: string | null
          target_type?: string | null
          user_agent?: string | null
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_type?: string
          actor_user_id?: string | null
          created_at?: string
          id?: never
          ip_address?: unknown
          metadata?: Json
          project_id?: string | null
          target_id?: string | null
          target_type?: string | null
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
      connector_credentials: {
        Row: {
          access_token_expires_at: string | null
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
            foreignKeyName: "connector_credentials_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_credentials_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_summaries: {
        Row: {
          created_at: string
          headline: string | null
          highlights: Json
          id: string
          llm_run_id: string | null
          metrics: Json
          project_id: string
          summary: string
          summary_date: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          headline?: string | null
          highlights?: Json
          id?: string
          llm_run_id?: string | null
          metrics?: Json
          project_id: string
          summary: string
          summary_date: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          headline?: string | null
          highlights?: Json
          id?: string
          llm_run_id?: string | null
          metrics?: Json
          project_id?: string
          summary?: string
          summary_date?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_summaries_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
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
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          status: Database["public"]["Enums"]["integration_status"]
          sync_enabled: boolean
          sync_interval_seconds: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
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
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          status?: Database["public"]["Enums"]["integration_status"]
          sync_enabled?: boolean
          sync_interval_seconds?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
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
          project_id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          status?: Database["public"]["Enums"]["integration_status"]
          sync_enabled?: boolean
          sync_interval_seconds?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integrations_credential_id_workspace_id_fkey"
            columns: ["credential_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "connector_credentials"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "integrations_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      llm_runs: {
        Row: {
          cache_creation_tokens: number | null
          cache_read_tokens: number | null
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
          project_id: string
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
          project_id: string
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
          project_id?: string
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
            foreignKeyName: "llm_runs_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      normalized_events: {
        Row: {
          actor: string | null
          actor_display: string | null
          actor_email: string | null
          body: string | null
          dedupe_key: string
          id: string
          ingested_at: string
          integration_id: string
          metadata: Json
          occurred_at: string
          processed_at: string | null
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          raw_event_id: string | null
          resource: string | null
          resource_type: string | null
          resource_url: string | null
          title: string | null
          type: string
          workspace_id: string
        }
        Insert: {
          actor?: string | null
          actor_display?: string | null
          actor_email?: string | null
          body?: string | null
          dedupe_key: string
          id: string
          ingested_at?: string
          integration_id: string
          metadata?: Json
          occurred_at: string
          processed_at?: string | null
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          raw_event_id?: string | null
          resource?: string | null
          resource_type?: string | null
          resource_url?: string | null
          title?: string | null
          type: string
          workspace_id: string
        }
        Update: {
          actor?: string | null
          actor_display?: string | null
          actor_email?: string | null
          body?: string | null
          dedupe_key?: string
          id?: string
          ingested_at?: string
          integration_id?: string
          metadata?: Json
          occurred_at?: string
          processed_at?: string | null
          project_id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          raw_event_id?: string | null
          resource?: string | null
          resource_type?: string | null
          resource_url?: string | null
          title?: string | null
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "normalized_events_integration_id_workspace_id_fkey"
            columns: ["integration_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "normalized_events_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      projects: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          health_score: number | null
          id: string
          name: string
          slug: string
          status: Database["public"]["Enums"]["project_status"]
          timezone: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          health_score?: number | null
          id?: string
          name: string
          slug: string
          status?: Database["public"]["Enums"]["project_status"]
          timezone?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          health_score?: number | null
          id?: string
          name?: string
          slug?: string
          status?: Database["public"]["Enums"]["project_status"]
          timezone?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_events: {
        Row: {
          id: string
          ingested_at: string
          integration_id: string
          occurred_at: string | null
          payload: Json
          payload_hash: string | null
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_event_id: string | null
          sync_job_id: string | null
          workspace_id: string
        }
        Insert: {
          id: string
          ingested_at?: string
          integration_id: string
          occurred_at?: string | null
          payload: Json
          payload_hash?: string | null
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_event_id?: string | null
          sync_job_id?: string | null
          workspace_id: string
        }
        Update: {
          id?: string
          ingested_at?: string
          integration_id?: string
          occurred_at?: string | null
          payload?: Json
          payload_hash?: string | null
          project_id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          provider_event_id?: string | null
          sync_job_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_events_integration_id_workspace_id_fkey"
            columns: ["integration_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          attempt: number
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
          project_id: string
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
          project_id: string
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
          project_id?: string
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
            foreignKeyName: "sync_jobs_integration_id_workspace_id_fkey"
            columns: ["integration_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "sync_jobs_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
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
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
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
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
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
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_workspace_ids: { Args: never; Returns: string[] }
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
      connector_provider:
        | "slack"
        | "google_chat"
        | "google_drive"
        | "clickup"
        | "mock"
        | "gmail"
      integration_status:
        | "pending"
        | "connected"
        | "degraded"
        | "error"
        | "revoked"
        | "disconnected"
      llm_run_kind: "action_items" | "daily_summary" | "backfill"
      llm_run_status: "queued" | "running" | "succeeded" | "failed"
      project_status: "active" | "paused" | "archived"
      sync_job_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
      sync_trigger: "schedule" | "manual" | "webhook" | "backfill"
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
      connector_provider: [
        "slack",
        "google_chat",
        "google_drive",
        "clickup",
        "mock",
        "gmail",
      ],
      integration_status: [
        "pending",
        "connected",
        "degraded",
        "error",
        "revoked",
        "disconnected",
      ],
      llm_run_kind: ["action_items", "daily_summary", "backfill"],
      llm_run_status: ["queued", "running", "succeeded", "failed"],
      project_status: ["active", "paused", "archived"],
      sync_job_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
      ],
      sync_trigger: ["schedule", "manual", "webhook", "backfill"],
      workspace_role: ["owner", "admin", "member", "viewer"],
    },
  },
} as const
