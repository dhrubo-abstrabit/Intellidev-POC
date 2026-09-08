import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The built-in UI against the authentication gate.
 *
 * Every `/api/*` route requires a bearer token. The page is a single static file with no build
 * step, so nothing type-checks its calls — and each of these mistakes looked like a broken
 * feature rather than a missing header when it happened.
 */
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

describe('the built-in UI carries its token everywhere', () => {
  it('does not use EventSource, which cannot send an Authorization header', () => {
    /**
     * FOUND BY DISPATCHING A TASK. The run stream was an `EventSource`, which has no way to set
     * request headers — so every connection returned 401 once the API was gated, and the only
     * visible symptom was "stream interrupted — reconnecting…" repeating while the run itself
     * ran perfectly.
     *
     * The replacement reads the same server-sent events over `fetch`, which can carry the token.
     */
    expect(page).not.toContain('new EventSource')
  })

  it('keeps the token out of the query string', () => {
    /**
     * The obvious fix for EventSource is `?access_token=…`, and it is the wrong one: a URL is
     * recorded in load balancer access logs, in browser history and in referrers. A bearer token
     * belongs in a header.
     */
    expect(page).not.toMatch(/[?&](access_token|token|jwt|apikey)=/)
  })

  it('sends the token on API calls without editing every call site', () => {
    // `fetch` is wrapped once. Twenty call sites each remembering a header is twenty chances to
    // forget one, and a forgotten one reads as a broken panel rather than as a missing header.
    expect(page).toContain('window.fetch = async')
    expect(page).toContain('authorization: `Bearer ${token}`')
  })

  it('stores the token in sessionStorage rather than localStorage', () => {
    // A bearer credential should not outlive the tab on disk.
    expect(page).toContain('sessionStorage.getItem(TOKEN_KEY)')
    expect(page).not.toMatch(/localStorage\.(get|set)Item\(\s*TOKEN_KEY/)
  })
})

describe('the sign-in popup', () => {
  it('does not ask for noopener on the window it needs to navigate', () => {
    /**
     * FOUND BY CLICKING IT. `window.open` returns null whenever `noopener` is set — there is no
     * handle to give back, by specification. The window opened, stayed `about:blank`, and
     * nothing could navigate it, for both harnesses.
     *
     * The handle is the entire reason the window is opened blank on the click and navigated
     * afterwards, so the two cannot both be had.
     */
    const call = page.match(/window\.open\([^)]*\)/)
    expect(call).not.toBeNull()
    expect(call![0]).not.toContain('noopener')
    // The anchor fallback still carries it, since nothing needs that window's handle.
    expect(page).toContain('rel="noopener noreferrer"')
  })
})

describe('the stage editor', () => {
  it('never renders a stage id or prompt without escaping it', () => {
    /**
     * Stage ids and prompts are written by people and rendered back into HTML. The id is
     * constrained to a slug by the schema, but the prompt is free text and the editor shows it
     * before anything has validated it — so the escaping has to be in the page, not assumed
     * from the server.
     */
    expect(page).toContain('function escapeAttr')
    expect(page).toContain('function escapeHtmlText')
    expect(page).toContain('escapeAttr(stage.id)')
    expect(page).toContain('escapeHtmlText(stage.prompt')
  })

  it('offers the approval flag on every stage', () => {
    // The whole feature, from the person's side: a checkbox that stops the run and costs nothing
    // while it waits.
    expect(page).toContain('data-stage-approval')
    expect(page).toContain('requiresApproval')
  })

  it('says where the current stages came from', () => {
    // "The space decided this" and "this project overrode it" look identical from the stage list
    // alone, and that is exactly the question someone editing them has.
    expect(page).toContain('space-default')
    expect(page).toContain('project-default')
    expect(page).toContain('built-in')
  })

  it('decides a parked run through the api rather than by reloading', () => {
    // A reload would lose the log and the open stream, and re-ask the server for everything the
    // page already has. (The page reloads in one other place — after signing out — so this
    // asserts the decision path specifically rather than the whole file.)
    expect(page).toContain('/decision')
    const decide = page.slice(page.indexOf('const decide = async'))
    expect(decide.slice(0, decide.indexOf("$('approveRun').onclick"))).not.toContain(
      'location.reload',
    )
  })

  it('has a module script the browser can actually parse', async () => {
    /**
     * FOUND BY OPENING THE PAGE. The HTML parser ends a script block at the first unescaped
     * closing tag it meets — inside a string, a template literal or a comment, it makes no
     * difference. The artifact preview builds a document containing script tags, and a comment
     * *explaining* that hazard contained the literal sequence: prettier reformatted the file
     * around it, and the whole page stopped loading with "Invalid or unexpected token".
     *
     * Nothing caught it. A syntax check over the file's text passes, because the text is valid
     * JavaScript — the damage happens in the HTML tokenizer, before the JavaScript parser sees
     * anything. So this cuts the block the way a browser does and parses *that*.
     */
    const { rmSync, writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFileSync } = await import('node:child_process')

    // Exactly the browser's rule: everything up to the first unescaped closing tag.
    const script = page.split('<script type="module">')[1]?.split('</script>')[0] ?? ''
    expect(script.length).toBeGreaterThan(1000)

    const dir = mkdtempSync(join(tmpdir(), 'idv-page-'))
    const file = join(dir, 'page.mjs')
    try {
      writeFileSync(file, script)
      // `--check` parses without running, which is all that is being asked.
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not close the event stream when a run parks', () => {
    /**
     * FOUND BY APPROVING A RUN. `parked` is a `run.finished` like any other, so the stream
     * closed on it — and re-following replayed from the start, met that same frame again and
     * closed immediately. Every event from the resumed container was recorded and none was
     * ever shown: the log stopped dead at the approval and the pull request appeared from
     * nowhere.
     *
     * Asserted on the condition rather than on a call, because the previous version of this
     * test pinned the *mechanism* (`follow(state.run)`) and so failed when the mechanism was
     * replaced by something that made it unnecessary.
     */
    expect(page).toContain("event.data.outcome !== 'parked'")
  })

  it('turns an answered approval into a record rather than leaving the buttons live', () => {
    // They stayed clickable after a successful approval, so the obvious next thing to do was
    // press them again — which answered "not awaiting a decision" and read as a failure, when
    // the approval had already worked and opened the pull request.
    expect(page).toContain("'Approved' : 'Rejected'")
  })
})

describe('the stage editor lays out', () => {
  /**
   * FOUND BY LOOKING AT IT. The first version reused `.srv`, which is `display: flex` — so every
   * child of a stage card became a narrow column beside its siblings. The screenshot was a
   * sentence rendered one word per line, two hundred pixels tall, next to inputs with no width.
   *
   * These assert the rules that were missing, because a static page has nothing else checking
   * that what it renders is usable.
   */
  it('gives stage cards their own block layout rather than reusing the flex row', () => {
    expect(page).toContain('.stage {')
    expect(page).toContain('.stage-head {')
    // The class whose `display: flex` caused it must not be what a stage card uses.
    expect(page).not.toMatch(/<div class="srv">\s*<div class="stage-head"/)
  })

  it('stops the global input rule making checkboxes full width', () => {
    /**
     * `input { width: 100% }` was written when every input on the page was a text field. The
     * first checkbox took the whole row and left its label zero pixels wide — which is exactly
     * how a one-line sentence became a two-hundred-pixel column.
     */
    expect(page).toMatch(/input\[type='checkbox'\][\s\S]{0,120}width: auto/)
  })

  it('sizes the panes without guessing the header height', () => {
    /**
     * `calc(100vh - 53px)` was here while the header measured 70px, so the page overflowed by
     * the difference — and would break again the next time the header changed. A flex column
     * measures it instead.
     */
    /**
     * Scoped to `.layout`, deliberately.
     *
     * The run-log panel has its own `calc(100vh - 320px)`, which is a different thing — a
     * scrollable box sized to fill, not the page frame — and a broader assertion would fail on
     * that, or on the comment that explains this fix by naming the old value.
     */
    const layoutRule = page.slice(page.indexOf('.layout {'), page.indexOf('.side {'))
    expect(layoutRule).not.toMatch(/height:\s*calc\(100vh/)
    expect(page).toContain('flex-direction: column')
    expect(page).toMatch(/\.side,\s*\.main \{\s*overflow-y: auto/)
  })

  it('keeps the page scroll below the breakpoint, where there is one column', () => {
    // Fixing the height there would put content under the fold with nothing to scroll it.
    expect(page).toContain('@media (min-width: 901px)')
  })
})

describe('the stage editor is a dialog', () => {
  it('edits in a modal rather than in the sidebar column', () => {
    /**
     * Editing a pipeline is work in its own right — several stages, each with a prompt worth
     * reading — and a 380px column gave it a textarea the width of a phone under a list that
     * pushed the rest of the page off screen.
     *
     * `showModal` rather than a hidden div: focus is trapped, Escape closes it and the page
     * behind is inert, none of which has to be written here.
     */
    expect(page).toContain('<dialog class="sheet" id="stagesDialog"')
    expect(page).toContain('showModal()')
  })

  it('leaves a summary behind, so the sidebar still answers what will happen', () => {
    // "Is the review stage still in there?" should not require opening anything.
    expect(page).toContain('stagesSummary')
    expect(page).toContain("' → '")
  })

  it('keeps the dialog open when a save fails', () => {
    // Dismissing on failure would throw away the work someone just did, and the message with it.
    expect(page).toMatch(/if \(res\.ok\) \{[\s\S]{0,400}stagesDialog'\)\.close\(\)/)
  })
})

describe('the default stages carry their own instructions', () => {
  it('ships no promptFile in what the control plane creates', async () => {
    /**
     * Prompts lived in `examples/bundle/prompts/*.md`, baked into the image — which made them
     * exactly as editable as the image, and the whole point of configurable stages is that a
     * project can say what a stage should do.
     *
     * Read from the built-in template rather than the page, because that is what seeds the row a
     * person then edits.
     */
    const { builtInStageTemplate } = await import('../src/dispatch.js')
    const template = builtInStageTemplate('https://github.com/a/b.git')
    const agents = template.stages.filter((s) => s.kind === 'agent')

    expect(agents.length).toBeGreaterThan(0)
    for (const stage of agents) {
      expect(stage.promptFile, `${stage.id} still points at a bundled file`).toBeUndefined()
      expect(stage.prompt?.length ?? 0, `${stage.id} has no instructions`).toBeGreaterThan(50)
    }
  })
})
