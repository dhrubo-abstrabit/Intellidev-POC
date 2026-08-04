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

const slackSchema = z.object({
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_OAUTH_STATE_SECRET: z.string().min(16),
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
  .extend(llmSchema.shape);

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
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
