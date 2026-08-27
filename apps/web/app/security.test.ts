import { describe, expect, it } from 'vitest'
import { ARTIFACT_CSP, inlineType } from '../lib/serving'

/**
 * The two rules that keep agent-authored content from becoming XSS.
 *
 * Both are one careless edit away from being untrue, and neither fails
 * visibly when it is — the page still renders, the image still loads. So they
 * are asserted directly.
 */

describe('the artifact frame', () => {
  it('never restores connect-src', () => {
    // The frame runs model-authored script. Denying it the network is what
    // stops that script sending what it can see anywhere.
    expect(ARTIFACT_CSP).toContain("connect-src 'none'")
    expect(ARTIFACT_CSP).toContain("default-src 'none'")
  })

  it('does not allow same-origin', () => {
    // `allow-scripts` with `allow-same-origin` is not a sandbox at all: the
    // frame gets the embedder's real origin back and can read its cookies and
    // call its API. The pair must never appear together.
    expect(ARTIFACT_CSP).toContain('sandbox allow-scripts')
    expect(ARTIFACT_CSP).not.toContain('allow-same-origin')
  })

  it('cannot be framed by another site', () => {
    expect(ARTIFACT_CSP).toContain("frame-ancestors 'self'")
  })
})

describe('what the file API will serve inline', () => {
  it('serves images inline', () => {
    expect(inlineType('page-1.png')).toBe('image/png')
    expect(inlineType('shot.JPG')).toBe('image/jpeg')
  })

  it.each(['evil.html', 'evil.htm', 'evil.svg', 'evil.xhtml', 'evil.xml'])(
    'refuses to serve %s inline',
    (name) => {
      // Anything the browser executes in THIS origin is stored XSS by another
      // name — these files are written by a model, from material that can
      // include a fetched web page. They render through /artifact, which has
      // the sandbox and the CSP for it. SVG counts: it is an image that can
      // carry script.
      expect(inlineType(name)).toBeUndefined()
    },
  )

  it('serves text as plain text, never as html', () => {
    for (const name of ['notes.md', 'data.json', 'a.ts', 'style.css']) {
      expect(inlineType(name)).toBe('text/plain; charset=utf-8')
    }
  })

  it('refuses anything it does not recognise', () => {
    // An allowlist, so a new dangerous extension is inert by default rather
    // than by remembering to add it.
    expect(inlineType('thing.wasm')).toBeUndefined()
    expect(inlineType('noextension')).toBeUndefined()
  })
})
