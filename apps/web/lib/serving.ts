/**
 * What may be served, and how.
 *
 * Two rules that keep agent-authored content from becoming cross-site
 * scripting. They live here, apart from the routes that apply them, because
 * they are policy rather than plumbing — and because a rule with its own file
 * and its own tests is harder to relax by accident than a constant halfway
 * down a route handler.
 */

/**
 * The Content-Security-Policy for the artifact frame.
 *
 * `connect-src 'none'` is the load-bearing line: the frame runs model-authored
 * script, and denying it the network is what stops that script sending what it
 * can see anywhere. `sandbox allow-scripts` WITHOUT `allow-same-origin` is the
 * other — those two together are not a sandbox at all, because the frame gets
 * the embedder's real origin back and can read its cookies and call its API.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  // An artifact is inline script and inline style by construction.
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  // Inlined data only. No remote images, so no pixel that phones home.
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  // Never widen this.
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ')

/**
 * The Content-Type a workspace file may be served with INLINE, or undefined.
 *
 * An allowlist, not a lookup with a fallback, so a new dangerous extension is
 * inert by default rather than by someone remembering to add it. Anything not
 * named here is listed as a directory or downloaded as an attachment.
 *
 * Nothing the browser executes in this origin appears. These files are written
 * by a model, from material that can include a fetched web page — serving one
 * as `text/html` from here is stored XSS by another name. HTML and SVG render
 * through /artifact instead, which has the sandbox and the CSP for it. SVG
 * counts: it is an image that can carry script.
 */
export function inlineType(name: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    pdf: 'application/pdf',
    // Everything textual goes as plain text, never as text/html.
    md: 'text/plain; charset=utf-8',
    markdown: 'text/plain; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    csv: 'text/plain; charset=utf-8',
    json: 'text/plain; charset=utf-8',
    ts: 'text/plain; charset=utf-8',
    js: 'text/plain; charset=utf-8',
    py: 'text/plain; charset=utf-8',
    css: 'text/plain; charset=utf-8',
    yml: 'text/plain; charset=utf-8',
    yaml: 'text/plain; charset=utf-8',
    sh: 'text/plain; charset=utf-8',
  }
  return types[extension]
}
