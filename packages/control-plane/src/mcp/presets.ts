import type { McpAuthKind } from './types.js'

/**
 * Servers you can add with one click.
 *
 * Each one is here because it exercises a different path, not for convenience: Supabase is
 * the OAuth case, GitHub the static-bearer case, and the local fixture the case where the
 * whole chain can be checked without a third party being involved at all.
 */
export interface McpPreset {
  id: string
  name: string
  url: string
  auth: McpAuthKind
  hint: string
  /** Requested scopes; omitted means "everything the server advertises". */
  scope?: string
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'supabase',
    name: 'Supabase',
    url: 'https://mcp.supabase.com/mcp',
    auth: 'oauth2',
    // Read-only scopes by default: an agent that can read a schema is useful, and one that
    // can write to a database is a much larger decision than picking an item from a list.
    scope: 'organizations:read projects:read database:read edge_functions:read storage:read',
    hint: 'Opens Supabase consent in a popup. Read-only scopes; add write scopes yourself if a task needs them.',
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/x/repos/readonly',
    auth: 'bearer',
    hint: 'Paste a fine-grained PAT with read access to Contents and Metadata.',
  },
  {
    id: 'facts',
    name: 'Local fixture',
    url: 'http://127.0.0.1:4100/mcp',
    auth: 'bearer',
    hint: 'The bundled test server: run `node packages/control-plane/examples/facts-server.mjs`. Token: s3cret-fixture-token',
  },
]
