import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { callbackUrl } from '../src/server.js'

/**
 * The redirect URI an MCP authorization server is asked to register.
 *
 * FOUND BY CONNECTING SUPABASE ON THE DEPLOYED CONTROL PLANE. The scheme was hardcoded to
 * `http`, which is correct only for loopback — RFC 8252 permits plain HTTP there and requires
 * https everywhere else. Registration was refused with `redirect_uris.0: URL must use https, be
 * localhost, or use a custom scheme`, and nothing in the panel pointed at a scheme.
 */
describe('the MCP redirect URI', () => {
  it('uses the configured public URL, https and all', () => {
    expect(callbackUrl('control.guidr.tech', 'https://control.guidr.tech')).toBe(
      'https://control.guidr.tech/oauth/callback',
    )
  })

  it('never takes the scheme from the connection', () => {
    /**
     * The load balancer terminates TLS, so the request reaches this process as plain HTTP. A
     * redirect built from the connection would be `http://` on a public domain — exactly the
     * value that was refused.
     */
    expect(callbackUrl('control.guidr.tech', 'https://control.guidr.tech')).not.toContain(
      'http://control',
    )
  })

  it('keeps a developer on loopback working', () => {
    // The port has to be the real one: a client registered against an exact URI breaks on
    // PORT=4001, which is why the Host header was used in the first place.
    expect(callbackUrl('127.0.0.1:4001', undefined)).toBe('http://127.0.0.1:4001/oauth/callback')
    expect(callbackUrl('127.0.0.1:4001', 'http://127.0.0.1:4001')).toBe(
      'http://127.0.0.1:4001/oauth/callback',
    )
  })

  it('falls back to the header rather than failing on a malformed public URL', () => {
    // A bad value in configuration should not be the thing that stops a local sign-in.
    expect(callbackUrl('127.0.0.1:4000', 'not a url')).toBe('http://127.0.0.1:4000/oauth/callback')
  })

  it('is called with the public URL, not just the host', () => {
    /**
     * The scheme logic above was never the whole bug: the call site passed only the Host header,
     * so there was nothing better for the helper to use. Asserted against the source because
     * that argument is the regression, and it is invisible to a test of the function alone.
     */
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    expect(source).toContain('callbackUrl(request.headers.host, opts.dispatch.publicUrl)')
  })
})
