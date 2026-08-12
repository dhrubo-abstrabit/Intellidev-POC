/**
 * Newline-delimited JSON reassembly.
 *
 * Both harnesses stream NDJSON on stdout, and chunk boundaries land anywhere —
 * mid-object, mid-string, mid-multibyte-character. Parsing per chunk loses
 * events; this buffers until a newline and decodes with a streaming decoder so
 * split UTF-8 sequences survive.
 */
export class NdjsonBuffer {
  private buffer = ''
  private readonly decoder = new TextDecoder('utf-8')
  /** Lines that were not valid JSON. Surfaced rather than silently dropped. */
  readonly malformed: string[] = []

  /** Feed a chunk, get back every complete object it completed. */
  push(chunk: Uint8Array | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    return this.drain()
  }

  /** Call at stream end to parse a trailing line with no newline. */
  flush(): unknown[] {
    this.buffer += this.decoder.decode()
    const out = this.drain()
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest) {
      const parsed = this.parse(rest)
      if (parsed !== undefined) out.push(parsed)
    }
    return out
  }

  private drain(): unknown[] {
    const out: unknown[] = []
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const parsed = this.parse(line)
      if (parsed !== undefined) out.push(parsed)
    }
    return out
  }

  private parse(line: string): unknown {
    try {
      return JSON.parse(line)
    } catch {
      this.malformed.push(line.slice(0, 500))
      return undefined
    }
  }
}
