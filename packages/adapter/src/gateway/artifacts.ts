/**
 * Artifacts a stage writes, and reads back.
 *
 * The gap this fills: a run produces an event log and a pull request, so the diagram the design
 * stage worked out survives only as prose in the log — and the stage after it cannot read prose.
 * An artifact is named, so `code` can ask for what `design` drew.
 *
 * Everything goes through the control plane on the run's own bearer, like the state store: a
 * container holds exactly one credential, and giving a run bucket permissions would be a
 * standing grant for the sake of kilobytes.
 */
export interface ArtifactClientOptions {
  baseUrl: string
  runId: string
  /** The run's own bearer — the same one the credential broker checks. */
  runAuth: string
  fetchImpl?: typeof fetch
}

export type ArtifactKind = 'html' | 'markdown' | 'mermaid'

export interface ArtifactSummary {
  name: string
  kind: ArtifactKind
  title?: string
  stage?: string
  bytes: number
  updatedAt: string
}

export interface Artifact extends ArtifactSummary {
  body: string
}

/** Raised with the control plane's own explanation, so the agent can act on it. */
export class ArtifactRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ArtifactRefused'
  }
}

export class ArtifactClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: ArtifactClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async put(input: {
    name: string
    kind: ArtifactKind
    body: string
    title?: string
    stage?: string
  }): Promise<ArtifactSummary> {
    const res = await this.request('PUT', '', input)
    const body = (await res.json().catch(() => ({}))) as {
      artifact?: ArtifactSummary
      error?: string
    }
    /**
     * The server's message is passed through rather than replaced.
     *
     * Limits live in one place — the control plane — and it explains them in terms the agent
     * can act on ("at most 1048576 bytes; this one is 2200000"). A generic "could not save"
     * here would throw that away and leave the agent retrying the same oversized body.
     */
    if (!res.ok)
      throw new ArtifactRefused(body.error ?? `artifact write failed (${res.status})`, res.status)
    if (!body.artifact)
      throw new ArtifactRefused('the control plane returned no artifact', res.status)
    return body.artifact
  }

  async list(): Promise<ArtifactSummary[]> {
    const res = await this.request('GET', '')
    if (!res.ok) throw new ArtifactRefused(`could not list artifacts (${res.status})`, res.status)
    return ((await res.json()) as { artifacts?: ArtifactSummary[] }).artifacts ?? []
  }

  /** Undefined rather than throwing for a name that does not exist: asking is not an error. */
  async read(name: string): Promise<Artifact | undefined> {
    const res = await this.request('GET', `/${encodeURIComponent(name)}`)
    if (res.status === 404) return undefined
    if (!res.ok) throw new ArtifactRefused(`could not read ${name} (${res.status})`, res.status)
    return ((await res.json()) as { artifact?: Artifact }).artifact
  }

  private async request(method: 'GET' | 'PUT', suffix: string, body?: unknown): Promise<Response> {
    const base = this.opts.baseUrl.replace(/\/$/, '')
    return await this.fetchImpl(`${base}/internal/runs/${this.opts.runId}/artifacts${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.runAuth}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }
}
