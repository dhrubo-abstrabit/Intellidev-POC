/**
 * Renders one artifact inside the sandboxed preview frame.
 *
 * This file exists because the frame's content security policy names exactly one script source —
 * this origin — and therefore blocks inline script. That is the point: the frame renders content
 * an *agent* wrote, so nothing that arrives with the artifact may execute. A bootstrap inlined
 * into the document would need `unsafe-inline`, which would allow the artifact's scripts too.
 *
 * The frame is also sandboxed without `allow-same-origin`, so its origin is opaque: it cannot
 * read the parent's `sessionStorage` — where the bearer token lives — or its cookies, whatever
 * the artifact contains.
 *
 * The source arrives in a `<script type="application/json">` block. That is data, not code: the
 * browser will not execute an unknown script type, and `</script>` inside the body is escaped by
 * the parent before it is written.
 */
const node = document.getElementById('artifact-source')
const target = document.getElementById('artifact')

/** Anything thrown here would leave a blank pane, which reads as "the artifact is empty". */
function fail(message) {
  target.textContent = `Could not render this artifact: ${message}`
  target.className = 'failed'
}

async function render() {
  if (!node || !target) return
  let artifact
  try {
    artifact = JSON.parse(node.textContent)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }

  if (artifact.kind === 'mermaid') {
    if (!window.mermaid) return fail('the diagram library did not load')
    /**
     * `securityLevel: 'strict'` is the whole reason this is safe to render.
     *
     * Mermaid escapes labels and refuses click bindings in strict mode, which is what it is for:
     * drawing a diagram whose source came from somewhere you do not control.
     */
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: artifact.theme === 'dark' ? 'dark' : 'default',
    })
    try {
      const { svg } = await window.mermaid.render('artifact-diagram', artifact.body)
      // `innerHTML` with mermaid's own output, not the artifact's: strict mode has already
      // escaped everything that came from the source.
      target.innerHTML = svg
    } catch (error) {
      // A diagram that does not parse is the common case — an agent writing mermaid by hand
      // gets the syntax wrong — so it shows the error *and* the source, which is what someone
      // needs to see to fix it.
      target.className = 'failed'
      target.textContent = `This diagram does not parse: ${
        error instanceof Error ? error.message : String(error)
      }\n\n${artifact.body}`
    }
    return
  }

  if (artifact.kind === 'markdown') {
    if (!window.marked) return fail('the markdown library did not load')
    /**
     * Rendered here rather than by the parent, because markdown may contain raw HTML — so the
     * *output* needs the same containment as an html artifact, and this frame already provides
     * it. Any script the markdown carries is inline and therefore blocked by the policy.
     */
    target.innerHTML = window.marked.parse(artifact.body, { breaks: true, gfm: true })

    /**
     * Mermaid fences inside markdown are drawn too.
     *
     * A design note is usually prose *with* a diagram in it, and a fenced block rendered as
     * grey monospace would be the one part of the document nobody can read.
     */
    const fences = [...target.querySelectorAll('pre > code.language-mermaid')]
    if (fences.length > 0 && window.mermaid) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: artifact.theme === 'dark' ? 'dark' : 'default',
      })
      for (const [index, fence] of fences.entries()) {
        try {
          const { svg } = await window.mermaid.render(`fence-${index}`, fence.textContent ?? '')
          const holder = document.createElement('div')
          holder.innerHTML = svg
          fence.closest('pre')?.replaceWith(holder)
        } catch {
          // Left as a code block. A diagram that does not parse is still readable as source,
          // and replacing it with an error would lose the text.
        }
      }
    }
    return
  }

  // `html`, which is served with `script-src 'none'` — so this branch is reached only when the
  // parent has already decided nothing in it may run.
  target.innerHTML = artifact.body
}

void render()
