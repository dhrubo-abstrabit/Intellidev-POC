import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { buildServer } from '../src/server.js'
import { InMemoryStore } from '../src/store/memory.js'
import { FileSeatStore } from '../src/harness/accounts.js'
import { FileMcpStore } from '../src/mcp/registry.js'
import { TEST_SCOPE } from './fixtures.js'

/**
 * How an artifact is shown, and why that is safe.
 *
 * An artifact's body was written by an agent, and an `html` one is arbitrary markup. It is
 * rendered in a frame that cannot reach the page around it — which is a claim worth testing,
 * because the page holds the bearer token in `sessionStorage` and a preview that could read it
 * would turn "the agent drew a diagram" into a credential leak.
 *
 * A static page has nothing else checking this, which is why these assert on the source.
 */
const page = await readFile(
  join(dirname(new URL(import.meta.url).pathname), '..', 'public', 'index.html'),
  'utf8',
)

const renderer = await readFile(
  join(dirname(new URL(import.meta.url).pathname), '..', 'public', 'artifact-preview.js'),
  'utf8',
)

describe('the artifact preview frame', () => {
  it('is sandboxed without allow-same-origin', () => {
    /**
     * The single most important line. `allow-same-origin` would give the frame this page's
     * origin, and with it `sessionStorage` — where the bearer token lives. An artifact could
     * then read the token of whoever opened it.
     */
    expect(page).toMatch(/sandbox="allow-scripts"/)
    expect(page).not.toMatch(/sandbox="[^"]*allow-same-origin/)
  })

  it('names this origin as the only place a script may come from', () => {
    // So nothing that arrives *with* an artifact executes: an inline script has no matching
    // source, and neither does a CDN.
    expect(page).toContain('script-src ${location.origin}')
    expect(page).toContain("default-src 'none'")
  })

  it('allows no script at all for an html artifact', () => {
    /**
     * An html artifact is arbitrary markup and needs no help from us to be displayed, so it
     * gets no script source — not even ours. The renderer is only needed to turn markdown and
     * mermaid into HTML.
     */
    const doc = page.slice(page.indexOf('function artifactDocument'))
    // Up to the `:` of the conditional — the html arm alone, not the arm that follows it.
    const htmlArm = doc.slice(doc.indexOf("artifact.kind === 'html'"), doc.indexOf(': `<meta'))
    expect(htmlArm).toMatch(/default-src 'none'; style-src 'unsafe-inline'/)
    expect(htmlArm).not.toContain('script-src')
  })

  it('passes the body as data rather than interpolating it into markup', () => {
    // A `<script type="application/json">` block is data — the browser will not execute an
    // unknown script type — so a body full of markup cannot become part of the document.
    expect(page).toContain('type="application/json" id="artifact-source"')
    expect(page).toContain('JSON.stringify({')
  })

  it('escapes the one sequence that would end that block early', () => {
    /**
     * JSON escaping does not cover `</script`. A body containing those literal characters would
     * close the block, and everything after it would be parsed as markup — which is exactly the
     * injection the data block exists to prevent.
     */
    expect(page).toContain('replace(/<\\/script/gi')
  })

  it('renders mermaid in strict mode', () => {
    // Strict mode escapes labels and refuses click bindings, which is what makes it safe to
    // draw a diagram whose source came from somewhere we do not control.
    // Both places it initialises — the standalone diagram and fences inside markdown — counted
    // on the call rather than on the string, which also appears in the comment explaining it.
    const initialisations = renderer.match(/mermaid\.initialize\(\{[\s\S]*?\}\)/g) ?? []
    expect(initialisations).toHaveLength(2)
    for (const call of initialisations) expect(call).toContain("securityLevel: 'strict'")
  })

  it('shows a diagram that will not parse, with its source', () => {
    // The common case — an agent writing mermaid by hand gets the syntax wrong — and the source
    // is what somebody needs in order to fix it.
    expect(renderer).toContain('does not parse')
  })
})

describe('serving the preview’s libraries', () => {
  async function server() {
    const work = await mkdtemp(join(tmpdir(), 'idv-vendor-'))
    return await buildServer({
      store: new InMemoryStore(),
      scope: TEST_SCOPE,
      dispatch: {
        mode: 'inline',
        bundleRoot: work,
        image: 'x',
        workRoot: work,
        projectId: TEST_SCOPE.projectId,
        publicUrl: 'http://127.0.0.1:4000',
      },
      mcp: await FileMcpStore.open(join(work, 'mcp.json')),
      accounts: await FileSeatStore.open(join(work, 'accounts.json')),
      // The real public directory, because the renderer is served from it.
      publicDir: join(dirname(new URL(import.meta.url).pathname), '..', 'public'),
    })
  }

  it('serves them from this origin rather than a CDN', async () => {
    /**
     * From here so the frame's policy can name one script source — this origin — and nothing
     * else. A CDN entry would mean allowing a third party to run script inside a pane rendering
     * agent-written content, which is the one place not to widen it. It also means the preview
     * works on a network that cannot reach a CDN.
     */
    const app = await server()
    for (const path of ['/vendor/marked.js', '/vendor/mermaid.js', '/vendor/artifact-preview.js']) {
      const res = await app.inject({ method: 'GET', url: path })
      expect(res.statusCode, path).toBe(200)
      expect(res.headers['content-type'], path).toMatch(/javascript/)
      expect(res.body.length, path).toBeGreaterThan(100)
    }
    await app.close()
  })

  it('serves them without a bearer token', async () => {
    // The frame has no credential of its own — an iframe subresource cannot carry an
    // Authorization header — and these are public libraries with nothing to protect.
    const app = await server()
    const res = await app.inject({ method: 'GET', url: '/vendor/marked.js' })
    await app.close()

    expect(res.statusCode).toBe(200)
  })
})
