export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_type: string
          actor_user_id: string | null
          client_space_id: string | null
          created_at: string
          id: string
          metadata: Json
          project_id: string | null
          target_id: string | null
          target_type: string | null
          tenant_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_type?: string
          actor_user_id?: string | null
          client_space_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          project_id?: string | null
          target_id?: string | null
          target_type?: string | null
          tenant_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_type?: string
          actor_user_id?: string | null
          client_space_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          project_id?: string | null
          target_id?: string | null
          target_type?: string | null
          tenant_id?: string
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
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
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
          context_profile: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          slug: string
          tenant_id: string
          timezone: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          context_profile?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          slug: string
          tenant_id: string
          timezone?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          context_profile?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          slug?: string
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
      context_documents: {
        Row: {
          archived_at: string | null
          client_space_id: string
          created_at: string
          created_by: string | null
          external_ref: Json
          extracted_text: string | null
          extraction_error: string | null
          extraction_status: string
          id: string
          kind: string
          mime_type: string | null
          project_id: string | null
          source: string
          storage_path: string | null
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          client_space_id: string
          created_at?: string
          created_by?: string | null
          external_ref?: Json
          extracted_text?: string | null
          extraction_error?: string | null
          extraction_status?: string
          id?: string
          kind: string
          mime_type?: string | null
          project_id?: string | null
          source: string
          storage_path?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          client_space_id?: string
          created_at?: string
          created_by?: string | null
          external_ref?: Json
          extracted_text?: string | null
          extraction_error?: string | null
          extraction_status?: string
          id?: string
          kind?: string
          mime_type?: string | null
          project_id?: string | null
          source?: string
          storage_path?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "context_documents_client_space_id_fkey"
            columns: ["client_space_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_documents_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_documents_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
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
        }
        Relationships: [
          {
            foreignKeyName: "daily_summaries_client_space_id_fkey"
            columns: ["client_space_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_summaries_llm_run_id_fkey"
            columns: ["llm_run_id"]
            isOneToOne: false
            referencedRelation: "llm_runs"
            referencedColumns: ["id"]
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
          mime_type: string | null
          normalized_event_id: string
          project_connector_id: string
          project_id: string
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
          mime_type?: string | null
          normalized_event_id: string
          project_connector_id: string
          project_id: string
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
          mime_type?: string | null
          normalized_event_id?: string
          project_connector_id?: string
          project_id?: string
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
            foreignKeyName: "event_attachments_connector_fkey"
            columns: ["project_connector_id", "project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "project_connectors"
            referencedColumns: ["id", "project_id", "client_space_id"]
          },
          {
            foreignKeyName: "event_attachments_normalized_event_id_fkey"
            columns: ["normalized_event_id"]
            isOneToOne: false
            referencedRelation: "normalized_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_attachments_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          client_space_id: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          project_id: string | null
          project_role: Database["public"]["Enums"]["project_role"] | null
          revoked_at: string | null
          space_role: Database["public"]["Enums"]["space_role"] | null
          tenant_id: string
          tenant_role: Database["public"]["Enums"]["tenant_role"] | null
          token_hash: string
          updated_at: string
          workspace_id: string | null
          workspace_role: Database["public"]["Enums"]["workspace_role"] | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          client_space_id?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          project_id?: string | null
          project_role?: Database["public"]["Enums"]["project_role"] | null
          revoked_at?: string | null
          space_role?: Database["public"]["Enums"]["space_role"] | null
          tenant_id: string
          tenant_role?: Database["public"]["Enums"]["tenant_role"] | null
          token_hash: string
          updated_at?: string
          workspace_id?: string | null
          workspace_role?: Database["public"]["Enums"]["workspace_role"] | null
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          client_space_id?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          project_id?: string | null
          project_role?: Database["public"]["Enums"]["project_role"] | null
          revoked_at?: string | null
          space_role?: Database["public"]["Enums"]["space_role"] | null
          tenant_id?: string
          tenant_role?: Database["public"]["Enums"]["tenant_role"] | null
          token_hash?: string
          updated_at?: string
          workspace_id?: string | null
          workspace_role?: Database["public"]["Enums"]["workspace_role"] | null
        }
        Relationships: [
          {
            foreignKeyName: "invitations_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "invitations_workspace_id_tenant_id_fkey"
            columns: ["workspace_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "tenant_id"]
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
          tenant_id: string
          updated_at: string
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
          tenant_id: string
          updated_at?: string
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
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_runs_client_space_id_tenant_id_fkey"
            columns: ["client_space_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "llm_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
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
          deleted_upstream_at: string | null
          id: string
          ingested_at: string
          metadata: Json
          occurred_at: string
          processed_at: string | null
          project_connector_id: string
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          raw_event_id: string | null
          resource: string | null
          resource_type: string | null
          resource_url: string | null
          superseded_by: string | null
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
          deleted_upstream_at?: string | null
          id: string
          ingested_at?: string
          metadata?: Json
          occurred_at: string
          processed_at?: string | null
          project_connector_id: string
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          raw_event_id?: string | null
          resource?: string | null
          resource_type?: string | null
          resource_url?: string | null
          superseded_by?: string | null
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
          deleted_upstream_at?: string | null
          id?: string
          ingested_at?: string
          metadata?: Json
          occurred_at?: string
          processed_at?: string | null
          project_connector_id?: string
          project_id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          raw_event_id?: string | null
          resource?: string | null
          resource_type?: string | null
          resource_url?: string | null
          superseded_by?: string | null
          title?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "normalized_events_project_connector_id_project_id_client_s_fkey"
            columns: ["project_connector_id", "project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "project_connectors"
            referencedColumns: ["id", "project_id", "client_space_id"]
          },
          {
            foreignKeyName: "normalized_events_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "normalized_events"
            referencedColumns: ["id"]
          },
        ]
      }
      project_connector_cursors: {
        Row: {
          created_at: string
          cursor: Json
          last_advanced_at: string
          project_connector_id: string
          scope_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          cursor: Json
          last_advanced_at?: string
          project_connector_id: string
          scope_key?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          cursor?: Json
          last_advanced_at?: string
          project_connector_id?: string
          scope_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_connector_cursors_project_connector_id_fkey"
            columns: ["project_connector_id"]
            isOneToOne: false
            referencedRelation: "project_connectors"
            referencedColumns: ["id"]
          },
        ]
      }
      project_connectors: {
        Row: {
          client_space_id: string
          config: Json
          connection_id: string
          consecutive_failures: number
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          last_error: string | null
          last_sync_started_at: string | null
          last_sync_succeeded_at: string | null
          next_sync_at: string
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          sync_enabled: boolean
          sync_interval_seconds: number
          updated_at: string
        }
        Insert: {
          client_space_id: string
          config?: Json
          connection_id: string
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_sync_started_at?: string | null
          last_sync_succeeded_at?: string | null
          next_sync_at?: string
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          sync_enabled?: boolean
          sync_interval_seconds?: number
          updated_at?: string
        }
        Update: {
          client_space_id?: string
          config?: Json
          connection_id?: string
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_sync_started_at?: string | null
          last_sync_succeeded_at?: string | null
          next_sync_at?: string
          project_id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          sync_enabled?: boolean
          sync_interval_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_connectors_connection_id_client_space_id_fkey"
            columns: ["connection_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "space_connections"
            referencedColumns: ["id", "client_space_id"]
          },
          {
            foreignKeyName: "project_connectors_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_connectors_project_id_client_space_id_fkey"
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
          client_space_id: string
          created_at: string
          project_id: string
          role: Database["public"]["Enums"]["project_role"] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          added_by?: string | null
          client_space_id: string
          created_at?: string
          project_id: string
          role?: Database["public"]["Enums"]["project_role"] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          added_by?: string | null
          client_space_id?: string
          created_at?: string
          project_id?: string
          role?: Database["public"]["Enums"]["project_role"] | null
          updated_at?: string
          user_id?: string
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
            foreignKeyName: "project_members_client_space_id_user_id_fkey"
            columns: ["client_space_id", "user_id"]
            isOneToOne: false
            referencedRelation: "space_members"
            referencedColumns: ["client_space_id", "user_id"]
          },
          {
            foreignKeyName: "project_members_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      projects: {
        Row: {
          archived_at: string | null
          client_space_id: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          slug: string
          status: string
          updated_at: string
          visibility: Database["public"]["Enums"]["project_visibility"]
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          client_space_id: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          slug: string
          status?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["project_visibility"]
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          client_space_id?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          slug?: string
          status?: string
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
          occurred_at: string | null
          payload: Json
          payload_hash: string | null
          project_connector_id: string
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_event_id: string | null
          sync_job_id: string | null
        }
        Insert: {
          client_space_id: string
          id: string
          ingested_at?: string
          occurred_at?: string | null
          payload: Json
          payload_hash?: string | null
          project_connector_id: string
          project_id: string
          provider: Database["public"]["Enums"]["connector_provider"]
          provider_event_id?: string | null
          sync_job_id?: string | null
        }
        Update: {
          client_space_id?: string
          id?: string
          ingested_at?: string
          occurred_at?: string | null
          payload?: Json
          payload_hash?: string | null
          project_connector_id?: string
          project_id?: string
          provider?: Database["public"]["Enums"]["connector_provider"]
          provider_event_id?: string | null
          sync_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_events_project_connector_id_project_id_client_space_id_fkey"
            columns: ["project_connector_id", "project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "project_connectors"
            referencedColumns: ["id", "project_id", "client_space_id"]
          },
          {
            foreignKeyName: "raw_events_sync_job_id_fkey"
            columns: ["sync_job_id"]
            isOneToOne: false
            referencedRelation: "sync_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      search_chunks: {
        Row: {
          chunk_index: number
          client_space_id: string
          content: string
          content_hash: string
          created_at: string
          embed_attempts: number
          embed_error: string | null
          embed_status: Database["public"]["Enums"]["embed_status"]
          embedded_at: string | null
          embedding: string | null
          embedding_model: string | null
          fts: unknown
          id: string
          occurred_at: string
          page_number: number | null
          project_id: string | null
          provider: Database["public"]["Enums"]["connector_provider"] | null
          source_id: string
          source_kind: Database["public"]["Enums"]["chunk_source"]
          source_url: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          chunk_index?: number
          client_space_id: string
          content: string
          content_hash: string
          created_at?: string
          embed_attempts?: number
          embed_error?: string | null
          embed_status?: Database["public"]["Enums"]["embed_status"]
          embedded_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          fts?: unknown
          id?: string
          occurred_at: string
          page_number?: number | null
          project_id?: string | null
          provider?: Database["public"]["Enums"]["connector_provider"] | null
          source_id: string
          source_kind: Database["public"]["Enums"]["chunk_source"]
          source_url?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          chunk_index?: number
          client_space_id?: string
          content?: string
          content_hash?: string
          created_at?: string
          embed_attempts?: number
          embed_error?: string | null
          embed_status?: Database["public"]["Enums"]["embed_status"]
          embedded_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          fts?: unknown
          id?: string
          occurred_at?: string
          page_number?: number | null
          project_id?: string | null
          provider?: Database["public"]["Enums"]["connector_provider"] | null
          source_id?: string
          source_kind?: Database["public"]["Enums"]["chunk_source"]
          source_url?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_chunks_client_space_id_fkey"
            columns: ["client_space_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_chunks_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      space_connections: {
        Row: {
          account_domain: string | null
          auth_mode: Database["public"]["Enums"]["connector_auth_mode"]
          client_space_id: string
          config: Json
          connected_by: string | null
          created_at: string
          external_account_id: string
          external_account_label: string | null
          id: string
          last_validated_at: string | null
          nango_connection_id: string | null
          nango_provider_config_key: string | null
          provider: Database["public"]["Enums"]["connector_provider"]
          revoked_at: string | null
          secret_ciphertext: string | null
          secret_iv: string | null
          secret_key_version: number | null
          secret_rotated_at: string | null
          status: Database["public"]["Enums"]["integration_status"]
          updated_at: string
        }
        Insert: {
          account_domain?: string | null
          auth_mode: Database["public"]["Enums"]["connector_auth_mode"]
          client_space_id: string
          config?: Json
          connected_by?: string | null
          created_at?: string
          external_account_id: string
          external_account_label?: string | null
          id?: string
          last_validated_at?: string | null
          nango_connection_id?: string | null
          nango_provider_config_key?: string | null
          provider: Database["public"]["Enums"]["connector_provider"]
          revoked_at?: string | null
          secret_ciphertext?: string | null
          secret_iv?: string | null
          secret_key_version?: number | null
          secret_rotated_at?: string | null
          status?: Database["public"]["Enums"]["integration_status"]
          updated_at?: string
        }
        Update: {
          account_domain?: string | null
          auth_mode?: Database["public"]["Enums"]["connector_auth_mode"]
          client_space_id?: string
          config?: Json
          connected_by?: string | null
          created_at?: string
          external_account_id?: string
          external_account_label?: string | null
          id?: string
          last_validated_at?: string | null
          nango_connection_id?: string | null
          nango_provider_config_key?: string | null
          provider?: Database["public"]["Enums"]["connector_provider"]
          revoked_at?: string | null
          secret_ciphertext?: string | null
          secret_iv?: string | null
          secret_key_version?: number | null
          secret_rotated_at?: string | null
          status?: Database["public"]["Enums"]["integration_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "space_connections_client_space_id_fkey"
            columns: ["client_space_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "space_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      space_members: {
        Row: {
          client_space_id: string
          created_at: string
          invited_by: string | null
          joined_at: string
          role: Database["public"]["Enums"]["space_role"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          client_space_id: string
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["space_role"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          client_space_id?: string
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["space_role"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "space_members_client_space_id_tenant_id_fkey"
            columns: ["client_space_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "space_members_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "space_members_tenant_id_user_id_fkey"
            columns: ["tenant_id", "user_id"]
            isOneToOne: false
            referencedRelation: "tenant_members"
            referencedColumns: ["tenant_id", "user_id"]
          },
          {
            foreignKeyName: "space_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
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
          outcome: string | null
          project_connector_id: string
        }
        Insert: {
          batch_id: string
          client_space_id: string
          completed_at?: string | null
          created_at?: string
          id?: string
          outcome?: string | null
          project_connector_id: string
        }
        Update: {
          batch_id?: string
          client_space_id?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          outcome?: string | null
          project_connector_id?: string
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
            foreignKeyName: "sync_batch_members_project_connector_id_client_space_id_fkey"
            columns: ["project_connector_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "project_connectors"
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
        }
        Insert: {
          batch_date: string
          client_space_id: string
          created_at?: string
          id?: string
          llm_triggered_at?: string | null
        }
        Update: {
          batch_date?: string
          client_space_id?: string
          created_at?: string
          id?: string
          llm_triggered_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_batches_client_space_id_fkey"
            columns: ["client_space_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id"]
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
          max_attempts: number
          project_connector_id: string
          scheduled_for: string
          started_at: string | null
          status: Database["public"]["Enums"]["sync_job_status"]
          trigger: Database["public"]["Enums"]["sync_trigger"]
          updated_at: string
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
          max_attempts?: number
          project_connector_id: string
          scheduled_for?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["sync_job_status"]
          trigger?: Database["public"]["Enums"]["sync_trigger"]
          updated_at?: string
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
          max_attempts?: number
          project_connector_id?: string
          scheduled_for?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["sync_job_status"]
          trigger?: Database["public"]["Enums"]["sync_trigger"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_jobs_project_connector_id_client_space_id_fkey"
            columns: ["project_connector_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "project_connectors"
            referencedColumns: ["id", "client_space_id"]
          },
        ]
      }
      task_sources: {
        Row: {
          chunk_id: string | null
          client_space_id: string
          linked_at: string
          linked_by: string | null
          llm_run_id: string | null
          normalized_event_id: string
          relevance: number | null
          role: string
          task_id: string
        }
        Insert: {
          chunk_id?: string | null
          client_space_id: string
          linked_at?: string
          linked_by?: string | null
          llm_run_id?: string | null
          normalized_event_id: string
          relevance?: number | null
          role?: string
          task_id: string
        }
        Update: {
          chunk_id?: string | null
          client_space_id?: string
          linked_at?: string
          linked_by?: string | null
          llm_run_id?: string | null
          normalized_event_id?: string
          relevance?: number | null
          role?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_sources_chunk_id_fkey"
            columns: ["chunk_id"]
            isOneToOne: false
            referencedRelation: "search_chunks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_sources_client_space_id_fkey"
            columns: ["client_space_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_sources_linked_by_fkey"
            columns: ["linked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_sources_llm_run_id_fkey"
            columns: ["llm_run_id"]
            isOneToOne: false
            referencedRelation: "llm_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_sources_normalized_event_id_fkey"
            columns: ["normalized_event_id"]
            isOneToOne: false
            referencedRelation: "normalized_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_sources_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          assignee_team_member_id: string | null
          client_space_id: string
          confidence: number
          created_at: string
          dedupe_hash: string
          description: string | null
          due_at: string | null
          embedding: string | null
          embedding_model: string | null
          embedding_src_hash: string | null
          for_date: string
          generated_at: string
          id: string
          kind: Database["public"]["Enums"]["task_kind"]
          llm_run_id: string | null
          owner_hint: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          project_id: string | null
          resolved_at: string | null
          snoozed_until: string | null
          status: Database["public"]["Enums"]["task_status"]
          superseded_by: string | null
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          assignee_id?: string | null
          assignee_team_member_id?: string | null
          client_space_id: string
          confidence: number
          created_at?: string
          dedupe_hash: string
          description?: string | null
          due_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          embedding_src_hash?: string | null
          for_date: string
          generated_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["task_kind"]
          llm_run_id?: string | null
          owner_hint?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id?: string | null
          resolved_at?: string | null
          snoozed_until?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          superseded_by?: string | null
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          assignee_id?: string | null
          assignee_team_member_id?: string | null
          client_space_id?: string
          confidence?: number
          created_at?: string
          dedupe_hash?: string
          description?: string | null
          due_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          embedding_src_hash?: string | null
          for_date?: string
          generated_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["task_kind"]
          llm_run_id?: string | null
          owner_hint?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id?: string | null
          resolved_at?: string | null
          snoozed_until?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          superseded_by?: string | null
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_assignee_team_member_id_workspace_id_fkey"
            columns: ["assignee_team_member_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "tasks_client_space_id_workspace_id_fkey"
            columns: ["client_space_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "client_spaces"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "tasks_llm_run_id_client_space_id_fkey"
            columns: ["llm_run_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "llm_runs"
            referencedColumns: ["id", "client_space_id"]
          },
          {
            foreignKeyName: "tasks_project_id_client_space_id_fkey"
            columns: ["project_id", "client_space_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "client_space_id"]
          },
          {
            foreignKeyName: "tasks_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
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
      tenant_members: {
        Row: {
          created_at: string
          invited_by: string | null
          joined_at: string
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          invited_by?: string | null
          joined_at?: string
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_members_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_members_user_id_fkey"
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
          max_projects: number | null
          max_workspaces: number | null
          plan: string
          seats: number | null
          status: string
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
          max_projects?: number | null
          max_workspaces?: number | null
          plan?: string
          seats?: number | null
          status?: string
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
          max_projects?: number | null
          max_workspaces?: number | null
          plan?: string
          seats?: number | null
          status?: string
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
          settings: Json
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          domain?: string | null
          id?: string
          name: string
          settings?: Json
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          domain?: string | null
          id?: string
          name?: string
          settings?: Json
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
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
            foreignKeyName: "workspace_members_tenant_id_user_id_fkey"
            columns: ["tenant_id", "user_id"]
            isOneToOne: false
            referencedRelation: "tenant_members"
            referencedColumns: ["tenant_id", "user_id"]
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
          slug?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
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
      accept_invitation: { Args: { p_token: string }; Returns: string }
      ack_job: { Args: { p_msg_id: number }; Returns: boolean }
      create_tenant_and_workspace: {
        Args: { p_name: string; p_slug: string }
        Returns: {
          tenant_id: string
          workspace_id: string
        }[]
      }
      current_client_space_ids: { Args: never; Returns: string[] }
      current_project_ids: { Args: never; Returns: string[] }
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
      has_space_role: {
        Args: {
          p_client_space_id: string
          p_roles: Database["public"]["Enums"]["space_role"][]
        }
        Returns: boolean
      }
      has_tenant_role: {
        Args: {
          p_roles: Database["public"]["Enums"]["tenant_role"][]
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
      manageable_client_space_ids: { Args: never; Returns: string[] }
      manageable_project_ids: { Args: never; Returns: string[] }
      match_search_chunks: {
        Args: {
          p_client_space_id: string
          p_embedding: string
          p_embedding_model?: string
          p_exclude_source_ids?: string[]
          p_limit?: number
          p_max_distance?: number
          p_one_per_source?: boolean
          p_project_id?: string
        }
        Returns: {
          chunk_id: string
          citable_event_id: string
          content: string
          distance: number
          occurred_at: string
          page_number: number
          provider: Database["public"]["Enums"]["connector_provider"]
          source_id: string
          source_kind: Database["public"]["Enums"]["chunk_source"]
          source_url: string
          title: string
        }[]
      }
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
      chunk_source: "normalized_event" | "event_attachment" | "context_document"
      connector_auth_mode: "nango" | "api_key" | "none"
      connector_provider:
        | "slack"
        | "google"
        | "supabase"
        | "openai_codex"
        | "github"
        | "mock"
        | "gmail"
        | "google_drive"
        | "google_chat"
        | "clickup"
      embed_status: "pending" | "embedded" | "failed" | "skipped"
      integration_status:
        | "pending"
        | "connected"
        | "degraded"
        | "error"
        | "revoked"
        | "disconnected"
      llm_run_kind:
        | "extract"
        | "reconcile"
        | "daily_summary"
        | "embed"
        | "backfill"
        | "enrich_task"
      llm_run_status: "queued" | "running" | "succeeded" | "failed"
      project_role: "member" | "viewer"
      project_visibility: "space" | "restricted"
      space_role: "admin" | "member" | "viewer"
      sync_job_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
      sync_trigger: "schedule" | "manual" | "webhook" | "backfill"
      task_kind: "action" | "risk" | "blocker" | "update" | "follow_up"
      task_priority: "low" | "medium" | "high" | "urgent"
      task_status: "pending" | "in_progress" | "done" | "dismissed" | "snoozed"
      tenant_role: "owner" | "billing_admin" | "member"
      workspace_role: "admin" | "member" | "viewer"
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
      chunk_source: [
        "normalized_event",
        "event_attachment",
        "context_document",
      ],
      connector_auth_mode: ["nango", "api_key", "none"],
      connector_provider: [
        "slack",
        "google",
        "supabase",
        "openai_codex",
        "github",
        "mock",
        "gmail",
        "google_drive",
        "google_chat",
        "clickup",
      ],
      embed_status: ["pending", "embedded", "failed", "skipped"],
      integration_status: [
        "pending",
        "connected",
        "degraded",
        "error",
        "revoked",
        "disconnected",
      ],
      llm_run_kind: [
        "extract",
        "reconcile",
        "daily_summary",
        "embed",
        "backfill",
        "enrich_task",
      ],
      llm_run_status: ["queued", "running", "succeeded", "failed"],
      project_role: ["member", "viewer"],
      project_visibility: ["space", "restricted"],
      space_role: ["admin", "member", "viewer"],
      sync_job_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
      ],
      sync_trigger: ["schedule", "manual", "webhook", "backfill"],
      task_kind: ["action", "risk", "blocker", "update", "follow_up"],
      task_priority: ["low", "medium", "high", "urgent"],
      task_status: ["pending", "in_progress", "done", "dismissed", "snoozed"],
      tenant_role: ["owner", "billing_admin", "member"],
      workspace_role: ["admin", "member", "viewer"],
    },
  },
} as const

