import { z } from "zod";

/**
 * Server env is split into per-concern schemas, each independently
 * parseable, rather than one monolithic bundle. Two reasons: (1) a module
 * that only needs the crypto keys (e.g. lib/crypto/tokens.ts) shouldn't
 * fail to load in a unit test just because QSTASH_TOKEN isn't set; (2) the
 * error message points at the actual missing concern instead of a wall of
 * unrelated fields. `serverEnv()` still validates everything together for
 * the "fail fast at boot" case.
 */
const cryptoSchema = z.object({
  TOKEN_ENC_KEYS: z.string().min(1),
  TOKEN_ENC_ACTIVE_VERSION: z.string().min(1),
});

const supabaseServerSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const cronSchema = z.object({
  CRON_SECRET: z.string().min(1),
});

const queueSchema = z.object({
  // Upstash accounts provisioned in a specific region (e.g. eu-central-1)
  // must use that region's URL — the global endpoint 404s for them. Optional
  // because most accounts use the global default.
  QSTASH_URL: z.string().url().default("https://qstash.upstash.io"),
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
});

// SLACK_OAUTH_STATE_SECRET moved to oauthStateSchema below (it now signs
// state for every OAuth provider, not just Slack) — this schema keeps only
// what's Slack-specific.
const slackSchema = z.object({
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
});

// Distinct from the Slack/Google *sign-in* (Supabase Auth) secrets — this
// signs the CSRF `state` param for the connector OAuth flow shared by
// src/lib/oauth/*. `OAUTH_STATE_SECRET` is the canonical name; the fallback
// to the old Slack-only var exists because Vercel env vars are write-only
// once set (CLAUDE.md) — the already-deployed Slack secret's value can't be
// read back to copy under the new name, but it can keep signing state
// without any Vercel change.
const oauthStateSchema = z
  .object({
    OAUTH_STATE_SECRET: z.string().min(16).optional(),
    SLACK_OAUTH_STATE_SECRET: z.string().min(16).optional(),
  })
  .refine((v) => Boolean(v.OAUTH_STATE_SECRET ?? v.SLACK_OAUTH_STATE_SECRET), {
    message: "Either OAUTH_STATE_SECRET or SLACK_OAUTH_STATE_SECRET must be set",
  })
  .transform((v) => ({ stateSecret: (v.OAUTH_STATE_SECRET ?? v.SLACK_OAUTH_STATE_SECRET)! }));

// GOOGLE_CONNECTOR_* is deliberately separate from GOOGLE_OAUTH_CLIENT_ID/
// SECRET (.env.example) — those are Supabase Auth *sign-in* credentials,
// consumed only by `supabase config push`, never read by this app directly.
// The connector app needs its own client so its redirect-URI allow-list
// (three connector callbacks per origin) doesn't collide with Supabase
// Auth's, and so rotating it can never sign users out. The two may point at
// the same Google Cloud OAuth client if an operator prefers — this code
// doesn't care, it just never reads GOOGLE_OAUTH_CLIENT_ID/SECRET.
const googleSchema = z.object({
  GOOGLE_CONNECTOR_CLIENT_ID: z.string().min(1),
  GOOGLE_CONNECTOR_CLIENT_SECRET: z.string().min(1),
});

const llmSchema = z.object({
  LLM_PROVIDER: z.enum(["anthropic"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().min(1),
});

const serverSchema = cryptoSchema
  .extend(supabaseServerSchema.shape)
  .extend(cronSchema.shape)
  .extend(queueSchema.shape)
  .extend(slackSchema.shape)
  .extend(googleSchema.shape)
  .extend(llmSchema.shape)
  .extend({
    OAUTH_STATE_SECRET: z.string().min(16).optional(),
    SLACK_OAUTH_STATE_SECRET: z.string().min(16).optional(),
  });

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  // Optional here specifically so publicEnv() itself never throws over this
  // field — it's read by client-safe code (createClient() in
  // lib/supabase/browser.ts) that never touches NEXT_PUBLIC_APP_URL at all,
  // and eagerly requiring it there would break the browser client whenever
  // it's genuinely unset (a Preview deployment with no static value
  // configured — see appUrl() below, which is where this is actually
  // resolved and validated).
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
});

type ServerEnv = z.infer<typeof serverSchema>;
type PublicEnv = z.infer<typeof publicSchema>;

function formatIssues(prefix: string, error: z.ZodError): string {
  return `${prefix}:\n${error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`;
}

function parseWith<T extends z.ZodType>(schema: T, label: string): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(formatIssues(`Invalid ${label} environment variables`, result.error));
  }
  return result.data;
}

let cachedServerEnv: ServerEnv | undefined;

/** Every server secret, validated together. Use for boot-time checks. */
export function serverEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;
  cachedServerEnv = parseWith(serverSchema, "server");
  return cachedServerEnv;
}

/** Just the token-encryption keys. Never import from a Client Component. */
export function cryptoEnv() {
  return parseWith(cryptoSchema, "crypto");
}

/** Just the Supabase service-role key. Never import from a Client Component. */
export function supabaseServerEnv() {
  return parseWith(supabaseServerSchema, "Supabase server");
}

/** Just the Vercel Cron shared secret. */
export function cronEnv() {
  return parseWith(cronSchema, "cron");
}

/** Just the Upstash QStash credentials. */
export function queueEnv() {
  return parseWith(queueSchema, "queue");
}

/** Just the Slack OAuth app credentials. */
export function slackEnv() {
  return parseWith(slackSchema, "Slack");
}

/** The OAuth CSRF state-signing secret, shared by every connector's OAuth
 * flow (src/lib/oauth/state.ts) — not Slack-specific despite the fallback
 * env var name. */
export function oauthStateEnv() {
  return parseWith(oauthStateSchema, "OAuth state");
}

/** Just the Google connector app's OAuth client credentials. */
export function googleEnv() {
  return parseWith(googleSchema, "Google connector");
}

/** Just the LLM provider config. */
export function llmEnv() {
  return parseWith(llmSchema, "LLM");
}

let cachedPublicEnv: PublicEnv | undefined;

/** Public env — safe to import from Client Components. Lazy: importing this
 * module must never throw just because an unrelated secret is missing. */
export function publicEnv(): PublicEnv {
  if (cachedPublicEnv) return cachedPublicEnv;
  cachedPublicEnv = parseWith(publicSchema, "public");
  return cachedPublicEnv;
}

/**
 * The app's own externally-reachable base URL — used to build OAuth
 * redirect_uris and QStash callback URLs. SERVER-ONLY: reads
 * `process.env.VERCEL_URL` directly, which (unlike a `NEXT_PUBLIC_` var)
 * Next.js does not inline into client bundles, so this must never be
 * called from a Client Component.
 *
 * `NEXT_PUBLIC_APP_URL` is used verbatim when set — Production always sets
 * it explicitly, to its real custom domain (VERCEL_URL there is the
 * internal `*.vercel.app` alias, not what any OAuth app has registered).
 * When it's unset, falls back to Vercel's own per-deployment `VERCEL_URL`:
 * Preview deployments get a fresh unique URL every deploy, so there is no
 * single static value that's correct for the whole Preview environment —
 * see CLAUDE.md's "Google connector specifics" for why a stale value here
 * would silently break both OAuth callbacks and QStash-triggered syncs.
 */
export function appUrl(): string {
  const explicit = publicEnv().NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  throw new Error(
    "NEXT_PUBLIC_APP_URL is not set, and VERCEL_URL is unavailable to derive it from " +
      "(expected when running outside Vercel — set NEXT_PUBLIC_APP_URL explicitly, e.g. in .env.local).",
  );
}
