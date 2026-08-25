import { z } from "zod";

/**
 * Server env is split into per-concern schemas, each independently
 * parseable, rather than one monolithic bundle. Two reasons: (1) a module
 * that only needs one concern's vars shouldn't fail to load in a unit test
 * just because an unrelated secret (e.g. ANTHROPIC_API_KEY) isn't set; (2)
 * the error message points at the actual missing concern instead of a wall
 * of unrelated fields. `serverEnv()` still validates everything together
 * for the "fail fast at boot" case.
 */
const supabaseServerSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const cronSchema = z.object({
  CRON_SECRET: z.string().min(1),
});

const llmSchema = z.object({
  LLM_PROVIDER: z.enum(["anthropic"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().min(1),
});

/**
 * Self-hosted Nango (see NANGO_MIGRATION_LOG.md) — owns the OAuth handshake
 * and token storage entirely now for the Slack and Google CONNECTORS
 * (distinct from Google *sign-in*, which is Supabase Auth and never reads
 * this). NANGO_SECRET_KEY is per-environment (dev/prod each have their own,
 * per Nango's dashboard) — never the same value across local and deployed.
 */
const nangoSchema = z.object({
  NANGO_SERVER_URL: z.string().url(),
  NANGO_SECRET_KEY: z.string().min(1),
});

const serverSchema = supabaseServerSchema
  .extend(cronSchema.shape)
  .extend(llmSchema.shape)
  .extend(nangoSchema.shape);

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
  // Read by the Nango frontend SDK (new Nango({ host }) and
  // openConnectUI({ baseURL/apiURL })) — self-hosted deployments must
  // override both, since the SDK's built-in defaults point at Nango Cloud.
  // See components/dashboard/connect-provider-button.tsx.
  NEXT_PUBLIC_NANGO_HOST: z.string().url().optional(),
  NEXT_PUBLIC_NANGO_CONNECT_URL: z.string().url().optional(),
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

/** Just the Supabase service-role key. Never import from a Client Component. */
export function supabaseServerEnv() {
  return parseWith(supabaseServerSchema, "Supabase server");
}

/** Just the pg_cron/job-dispatch shared secret (job_dispatch_secret in
 * Vault is deliberately the same value — see the pgmq/pg_cron migration). */
export function cronEnv() {
  return parseWith(cronSchema, "cron");
}

/** Just the LLM provider config. */
export function llmEnv() {
  return parseWith(llmSchema, "LLM");
}

/** Just the self-hosted Nango server URL + secret key. Never import from a
 * Client Component — NANGO_SECRET_KEY is a server-only credential. */
export function nangoEnv() {
  return parseWith(nangoSchema, "Nango");
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
 * The app's own externally-reachable base URL — used for Supabase Auth's
 * sign-in callback and (via Vault's app_base_url secret, mirrored manually
 * — see supabase/local-dispatch-secrets.sql) the base pg_cron's dispatcher
 * fires job routes against. SERVER-ONLY: reads `process.env.VERCEL_URL`
 * directly, which (unlike a `NEXT_PUBLIC_` var) Next.js does not inline into
 * client bundles, so this must never be called from a Client Component.
 * Connector OAuth (Slack/Google) no longer uses this at all — Nango owns
 * that redirect URI now, on its own server.
 *
 * `NEXT_PUBLIC_APP_URL` is used verbatim when set — Production always sets
 * it explicitly, to its real custom domain (VERCEL_URL there is the
 * internal `*.vercel.app` alias, not a registered redirect). When it's
 * unset, falls back to Vercel's own per-deployment `VERCEL_URL`: Preview
 * deployments get a fresh unique URL every deploy, so there is no single
 * static value that's correct for the whole Preview environment.
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
