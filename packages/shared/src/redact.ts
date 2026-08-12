/**
 * Redaction for the event stream.
 *
 * The event log is the one artefact that leaves the container: it goes to Postgres,
 * to the UI, to the audit trail. A secret only has to be printed once — by a test, by
 * a stray `echo`, by a stack trace — to be in that log permanently.
 *
 * So redaction happens at the **bus**, not at the call sites. Every string in every
 * event payload is scanned before it is numbered and persisted. Call sites cannot be
 * trusted to remember, and a single missed one is a leak that outlives the run.
 */

/**
 * Values shorter than this are never redacted.
 *
 * A secret whose value is `1` or `test` would otherwise turn the whole log into
 * `[redacted]` and destroy the ability to debug anything. Short secrets are a
 * project-configuration problem, not something redaction can fix.
 */
export const MIN_REDACTABLE_LENGTH = 8

export interface Redactor {
  (text: string): string
  /** How many replacements have been made, for observability. */
  readonly count: () => number
  /** Secret names that were too short to redact safely. */
  readonly skipped: readonly string[]
}

/**
 * Build a redactor from named secret values.
 *
 * Longest values are replaced first: if one secret is a prefix of another, replacing
 * the shorter one first would leave a recognisable tail behind.
 */
export function createRedactor(secrets: Record<string, string>): Redactor {
  const skipped: string[] = []
  const entries: Array<{ name: string; value: string }> = []

  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (value.length < MIN_REDACTABLE_LENGTH) {
      skipped.push(name)
      continue
    }
    entries.push({ name, value })
  }
  entries.sort((a, b) => b.value.length - a.value.length)

  let replacements = 0

  const redact = (text: string): string => {
    if (!text) return text
    let out = text
    for (const { name, value } of entries) {
      if (!out.includes(value)) continue
      out = out.split(value).join(`[redacted:${name}]`)
      replacements++
    }
    return out
  }

  const fn = redact as unknown as { (text: string): string } & {
    count: () => number
    skipped: readonly string[]
  }
  Object.defineProperty(fn, 'count', { value: () => replacements })
  Object.defineProperty(fn, 'skipped', { value: Object.freeze([...skipped]) })
  return fn as Redactor
}

/** A redactor that does nothing, for runs with no secrets attached. */
export const noopRedactor: Redactor = (() => {
  const fn = ((text: string) => text) as unknown as Redactor
  Object.defineProperty(fn, 'count', { value: () => 0 })
  Object.defineProperty(fn, 'skipped', { value: Object.freeze([]) })
  return fn
})()

/**
 * Apply a redactor to every string in a structure, preserving its shape.
 *
 * Types survive — a number stays a number — so a redacted payload still satisfies the
 * event schema. Object keys are redacted too, because a secret used as a key would
 * otherwise slip through.
 */
export function redactDeep<T>(value: T, redactor: Redactor): T {
  if (typeof value === 'string') return redactor(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redactor(key)] = redactDeep(item, redactor)
    }
    return out as unknown as T
  }
  return value
}
