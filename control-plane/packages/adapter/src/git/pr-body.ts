import type { AgentEvent, HarnessId, StageRecord, TaskBrief } from '@intellidev/shared'
import type { DiffStat } from './repo.js'

/**
 * Assembles the PR description from the run's event log.
 *
 * Deliberately **not** written by the model. A reviewer needs to know what actually
 * happened — which checks ran, how many attempts a stage took, what the reviewer found
 * — and a model summarising its own work is exactly the wrong source for that. Every
 * line here traces to a recorded event or stage record.
 *
 * Pure, so it is testable without a repo, a network, or a harness.
 */

export interface PullRequestContent {
  title: string
  body: string
}

export interface PrBodyInput {
  task: TaskBrief
  events: readonly AgentEvent[]
  records: readonly StageRecord[]
  harness: HarnessId
  diff?: DiffStat
  /** Set when the base branch moved while the run worked. */
  baseMoved?: { moved: boolean; nowSha: string }
  baseBranch?: string
  runUrl?: string
}

/** Conventional-commit style subject, capped so git and GitHub both stay happy. */
export function buildPullRequestTitle(task: TaskBrief, maxLength = 72): string {
  const subject = task.title.trim().replace(/\s+/g, ' ').replace(/\.$/, '')
  if (subject.length <= maxLength) return subject
  return `${subject.slice(0, maxLength - 1).trimEnd()}…`
}

/**
 * A deterministic commit message.
 *
 * Derived from the task rather than asked of the model: two runs of the same task should
 * produce the same message, and a message is not the place for creativity.
 */
export function buildCommitMessage(task: TaskBrief): string {
  const subject = buildPullRequestTitle(task, 72)
  const firstParagraph =
    task.description
      .trim()
      .split(/\n\s*\n/)[0]
      ?.trim() ?? ''
  const lines = [subject]
  if (firstParagraph && firstParagraph !== subject) lines.push('', wrap(firstParagraph, 72))
  lines.push('', `Task: ${task.id}`)
  return `${lines.join('\n')}\n`
}

export function buildPullRequestBody(input: PrBodyInput): string {
  const sections: string[] = []

  sections.push(section('What was asked', asked(input.task)))

  const changed = changedFiles(input.events)
  sections.push(section('What changed', changes(input.diff, changed)))

  const checks = checkRows(input.events)
  if (checks.length > 0) sections.push(section('Checks', table(['Check', 'Result'], checks)))

  const review = reviewSummary(input.records)
  if (review) sections.push(section('Review', review))

  sections.push(section('How this ran', howItRan(input)))

  if (input.baseMoved?.moved) {
    sections.push(
      section(
        '⚠️ Base moved during this run',
        [
          `\`${input.baseBranch ?? 'base'}\` advanced to \`${input.baseMoved.nowSha.slice(0, 12)}\`` +
            ' after this branch was cut.',
          '',
          'This branch was **not** rebased — a silent rebase can turn a reviewed-clean diff',
          'into a wrong one. Rebase or merge before merging if the changes overlap.',
        ].join('\n'),
      ),
    )
  }

  sections.push("<!-- Assembled from this run's event log, not written by the model. -->")
  return sections.join('\n\n')
}

// --- sections --------------------------------------------------------------

function asked(task: TaskBrief): string {
  const parts = [task.description.trim()]
  if (task.details?.trim()) parts.push(task.details.trim())
  if (task.acceptanceCriteria.length > 0) {
    parts.push(
      ['**Acceptance criteria**', ...task.acceptanceCriteria.map((c) => `- ${c}`)].join('\n'),
    )
  }
  return parts.filter(Boolean).join('\n\n')
}

function changes(diff: DiffStat | undefined, files: readonly string[]): string {
  const lines: string[] = []
  if (diff) {
    lines.push(
      `\`${diff.filesChanged}\` file${diff.filesChanged === 1 ? '' : 's'} changed, ` +
        `\`+${diff.insertions}\` / \`-${diff.deletions}\``,
    )
  }
  if (files.length > 0) {
    lines.push('')
    // Cap the list: a hundred-file PR body helps nobody, and the diff is right there.
    const shown = files.slice(0, 25)
    lines.push(...shown.map((f) => `- \`${f}\``))
    if (files.length > shown.length) lines.push(`- …and ${files.length - shown.length} more`)
  }
  if (lines.length === 0) lines.push('_No file changes recorded._')
  return lines.join('\n')
}

function checkRows(events: readonly AgentEvent[]): string[][] {
  /** Last outcome per check, with how many times it ran. */
  const byLabel = new Map<string, { passed: boolean; attempts: number }>()
  for (const event of events) {
    if (event.type !== 'gate.evaluated') continue
    if (event.data.kind !== 'command') continue
    const label = event.data.label ?? '(unnamed check)'
    const existing = byLabel.get(label)
    byLabel.set(label, {
      passed: event.data.passed,
      attempts: (existing?.attempts ?? 0) + 1,
    })
  }
  return [...byLabel].map(([label, result]) => [
    `\`${label}\``,
    // Attempts matter: a suite that passed on the third try is a different signal from
    // one that passed first time, and a reviewer should see that.
    result.passed
      ? result.attempts > 1
        ? `✅ passed after ${result.attempts} attempts`
        : '✅ passed'
      : `❌ failed after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}`,
  ])
}

interface ReviewFinding {
  severity?: string
  file?: string
  line?: number
  summary?: string
}

function reviewSummary(records: readonly StageRecord[]): string | null {
  const review = [...records].reverse().find((r) => r.stage === 'review')
  if (!review) return null

  const reviewer = review.harness ? `**${review.harness}**` : 'a second harness'
  const output = review.output as { blocking?: number; findings?: ReviewFinding[] } | undefined
  if (!output) {
    return `Reviewed by ${reviewer}. ${review.gateDetail ?? 'No structured findings recorded.'}`
  }

  const findings = output.findings ?? []
  if (findings.length === 0) {
    return `Reviewed by ${reviewer}. No findings.`
  }

  const lines = [
    `Reviewed by ${reviewer} — ${output.blocking ?? 0} blocking, ` +
      `${findings.length - (output.blocking ?? 0)} suggestion${findings.length - (output.blocking ?? 0) === 1 ? '' : 's'}.`,
    '',
  ]
  for (const finding of findings.slice(0, 20)) {
    const where = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\`` : ''
    const mark = finding.severity === 'blocking' ? '**blocking**' : 'suggestion'
    lines.push(`- ${mark} ${where} ${finding.summary ?? ''}`.trim())
  }
  return lines.join('\n')
}

function howItRan(input: PrBodyInput): string {
  const rows: string[][] = [['Harness', `\`${input.harness}\``]]

  const path = stagePath(input.records)
  if (path) rows.push(['Stages', path])

  const usage = [...input.events].reverse().find((e) => e.type === 'usage.updated')
  if (usage?.type === 'usage.updated') {
    rows.push([
      'Tokens',
      `${compact(usage.data.tokensIn)} in / ${compact(usage.data.tokensOut)} out` +
        (usage.data.tokensCacheRead > 0 ? ` / ${compact(usage.data.tokensCacheRead)} cached` : ''),
    ])
    if (usage.data.usdEst !== undefined) {
      // Labelled as approximate: for seat-based auth this is derived, not billed.
      rows.push(['Cost', `~$${usage.data.usdEst.toFixed(2)}`])
    }
  }
  if (input.runUrl) rows.push(['Run', input.runUrl])

  return table(['', ''], rows)
}

/** `design → branch → code → test(2) → review`, with retried stages marked. */
export function stagePath(records: readonly StageRecord[]): string | null {
  if (records.length === 0) return null
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const record of records) {
    counts.set(record.stage, (counts.get(record.stage) ?? 0) + 1)
    if (!order.includes(record.stage)) order.push(record.stage)
  }
  return order
    .map((stage) => {
      const count = counts.get(stage) ?? 1
      return count > 1 ? `${stage}(${count})` : stage
    })
    .join(' → ')
}

// --- formatting ------------------------------------------------------------

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`
}

function table(headers: string[], rows: string[][]): string {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

function changedFiles(events: readonly AgentEvent[]): string[] {
  const files = new Set<string>()
  for (const event of events) {
    if (event.type === 'file.changed') files.add(event.data.path)
  }
  return [...files].sort()
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function wrap(text: string, width: number): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line.length === 0) line = word
    else if (line.length + word.length + 1 <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}
