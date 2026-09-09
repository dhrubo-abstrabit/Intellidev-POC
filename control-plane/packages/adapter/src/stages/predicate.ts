/**
 * A deliberately tiny expression language for predicate gates.
 *
 * Gate expressions come from a project manifest, which means they are configuration
 * authored by humans and stored in a database — so `eval` is out of the question.
 * This supports exactly what a gate needs: dotted paths, comparisons, boolean
 * literals, and `&&` / `||` between them. Anything else is a configuration error,
 * reported as such rather than silently treated as false.
 */

export class PredicateError extends Error {}

const COMPARATORS = ['==', '!=', '>=', '<=', '>', '<'] as const
type Comparator = (typeof COMPARATORS)[number]

/** Read a dotted path out of the stage output. Missing paths are `undefined`. */
export function readPath(output: unknown, path: string): unknown {
  let current: unknown = output
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    const key = segment.trim()
    if (Array.isArray(current)) {
      if (key === 'length') {
        current = current.length
        continue
      }
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function parseLiteral(token: string): unknown {
  const text = token.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  const quoted = /^'(.*)'$/.exec(text) ?? /^"(.*)"$/.exec(text)
  if (quoted) return quoted[1]
  // Anything unquoted and non-numeric is a path into the output, not a string.
  return { __path: text }
}

function resolve(value: unknown, output: unknown): unknown {
  if (typeof value === 'object' && value !== null && '__path' in value) {
    return readPath(output, String((value as { __path: unknown }).__path))
  }
  return value
}

const isNullish = (value: unknown): boolean => value === null || value === undefined

function compare(left: unknown, op: Comparator, right: unknown): boolean {
  switch (op) {
    // A path that is absent and one that is explicitly null mean the same thing to a
    // gate — "the agent did not report this" — so they compare equal.
    case '==':
      return isNullish(left) || isNullish(right)
        ? isNullish(left) && isNullish(right)
        : left === right
    case '!=':
      return !(isNullish(left) || isNullish(right)
        ? isNullish(left) && isNullish(right)
        : left === right)
    default: {
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw new PredicateError(
          `cannot apply "${op}" to ${JSON.stringify(left)} and ${JSON.stringify(right)}`,
        )
      }
      if (op === '>') return left > right
      if (op === '<') return left < right
      if (op === '>=') return left >= right
      return left <= right
    }
  }
}

function evaluateComparison(expr: string, output: unknown): boolean {
  const text = expr.trim()
  if (!text) throw new PredicateError('empty expression')

  for (const op of COMPARATORS) {
    const at = text.indexOf(op)
    if (at === -1) continue
    // `>=` must win over `>`; COMPARATORS is ordered so the longer forms come first,
    // but a `>` found earlier in the string still needs this guard.
    if (op === '>' || op === '<') {
      if (text[at + 1] === '=') continue
    }
    const leftRaw = text.slice(0, at)
    const rightRaw = text.slice(at + op.length)
    const left = resolve(parseLiteral(leftRaw), output)
    const right = resolve(parseLiteral(rightRaw), output)
    return compare(left, op, right)
  }

  // A bare path is a truthiness check, which is what `passed` in a gate means.
  const bare = resolve(parseLiteral(text), output)
  return Boolean(bare)
}

/**
 * Evaluate a gate expression against a stage's structured output.
 *
 * `||` binds loosest, then `&&`. No parentheses — if a gate needs them, it wants a
 * command gate or a better-shaped output instead.
 */
export function evaluatePredicate(expr: string, output: unknown): boolean {
  const alternatives = splitTop(expr, '||')
  // An empty gate expression is a config bug that would otherwise read as a
  // permanently failing gate.
  if (alternatives.length === 0) throw new PredicateError('empty expression')
  for (const alternative of alternatives) {
    const conjuncts = splitTop(alternative, '&&')
    if (conjuncts.every((part) => evaluateComparison(part, output))) return true
  }
  return false
}

function splitTop(expr: string, separator: '&&' | '||'): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < expr.length; i++) {
    const char = expr[i]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (depth === 0 && expr.startsWith(separator, i)) {
      parts.push(expr.slice(start, i))
      i += separator.length - 1
      start = i + 1
    }
  }
  parts.push(expr.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}
