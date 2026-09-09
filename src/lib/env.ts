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

/** process.env carries "" for an unset var far more often than `undefined`
 * (dotenv, Vercel, and .env.example's own `KEY=` lines all produce it), and
 * `.optional()` alone only skips `undefined` — a present-but-blank value
 * still fails `.min(1)`. Normalize blank to absent so a conditionally
 * unused key doesn't fail validation just because it's declared empty in
 * .env.local. */
const optionalSecret = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

/**
 * The CHAT provider config only — which model answers generateActionItems/
 * consolidateActionItems, and its credential. Deliberately does NOT cover
 * OPENAI_API_KEY's embeddings use (see embeddingSchema below): embeddings
 * always call OpenAI regardless of which chat provider is selected, so
 * bundling that requirement in here would make every llmEnv() caller —
 * including the plain Anthropic chat path — demand an OpenAI key it has no
 * use for.
 *
 * Plain object, not `.superRefine()`'d — serverSchema below composes this
 * via `.shape`, and in zod v4 a `.superRefine()`'d schema has no `.shape`.
 * The refinement itself is applied twice (once to the exported `llmSchema`,
 * once as part of `serverSchema`) via the shared refineLlmKeys function
 * below, so the two can't drift.
 *
 * Each API key is conditional on LLM_PROVIDER selecting that provider,
 * enforced below rather than at the field level (Zod object fields can't
 * see their siblings).
 */
const llmSchemaBase = z.object({
  LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
  ANTHROPIC_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
});

function refineLlmKeys(
  env: { LLM_PROVIDER: "anthropic" | "openai"; ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string },
  ctx: z.RefinementCtx,
) {
  const required = env.LLM_PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (!env[required]) {
    ctx.addIssue({ code: "custom", path: [required], message: `required when LLM_PROVIDER="${env.LLM_PROVIDER}"` });
  }
}

const llmSchema = llmSchemaBase.superRefine(refineLlmKeys);

/**
 * OpenAI credential for EMBEDDINGS (services/search/embed.ts,
 * text-embedding-3-small) — unconditionally required, independent of
 * llmSchema/LLM_PROVIDER above. Retrieval-augmented extraction always
 * embeds via OpenAI even when the chat/extraction provider is Anthropic,
 * so this is its own concern, not folded into llmSchema (see that schema's
 * own doc comment for why bundling them would be wrong).
 *
 * Same OPENAI_API_KEY env var as llmSchema's optional field above — OpenAI
 * issues one key per project, so there's no reason to ask for two. The two
 * schemas simply apply different requiredness rules to it for their own
 * purposes; embeddingEnv() is what embed.ts actually calls.
 */
const embeddingSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
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

/**
 * AWS SES, for invitation email.
 *
 * Deliberately NOT part of `serverSchema` below, so a deployment without SES
 * configured still boots and every other feature keeps working — invitations
 * simply fall back to showing a copy-able link instead of mailing it (see
 * lib/invitations/email.ts). Email is the one concern here where "not
 * configured yet" is an expected state rather than a misconfiguration: SES
 * starts sandboxed and needs an AWS support request before it can mail
 * anyone, and the invite flow was built to be useful during that wait.
 *
 * SES_SECRET_ACCESS_KEY is shown by AWS exactly once, and Vercel env vars are
 * write-only after they are set, so this is a value with two chances to be
 * lost. Record it when it is generated.
 *
 * Deliberately NOT named AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY:
 * those are reserved on AWS Amplify Hosting (its SSR compute runs on Lambda,
 * which injects its own execution-role credentials under exactly those
 * names and refuses app-defined values there) — confirmed 2026-09-09 when
 * Amplify's console rejected setting them. Same three values, SES_-prefixed
 * names, read explicitly here rather than falling back to the AWS SDK's
 * default credential chain so this keeps working unchanged on any host.
 */
const sesSchema = z.object({
  SES_REGION: z.string().min(1),
  SES_ACCESS_KEY_ID: z.string().min(1),
  SES_SECRET_ACCESS_KEY: z.string().min(1),
  SES_FROM_ADDRESS: z.string().email(),
});

const serverSchema = supabaseServerSchema
  .extend(cronSchema.shape)
  .extend(llmSchemaBase.shape)
  .extend(embeddingSchema.shape)
  .extend(nangoSchema.shape)
  .superRefine(refineLlmKeys);

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

/** Just the OpenAI embeddings credential — always required, independent of
 * which chat provider llmEnv() resolves. Call this from services/search/
 * embed.ts, never llmEnv(), which has no opinion on embeddings at all. */
export function embeddingEnv() {
  return parseWith(embeddingSchema, "embedding");
}

/** Just the self-hosted Nango server URL + secret key. Never import from a
 * Client Component — NANGO_SECRET_KEY is a server-only credential. */
export function nangoEnv() {
  return parseWith(nangoSchema, "Nango");
}

/**
 * SES config, or null when it is not configured.
 *
 * Returns null rather than throwing because an unconfigured mailer is a
 * supported state: the caller degrades to a copy-able invite link. Every other
 * *Env() helper throws, because for those a missing value really is broken.
 */
export function sesEnv() {
  const result = sesSchema.safeParse(process.env);
  return result.success ? result.data : null;
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
