import { getSession } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Serves an agent-authored page into a sandboxed frame.
 *
 * This is a security boundary, not a convenience route. The content is written
 * by a model, from material that may include a web page someone else controls
 * (§9: fetched content is untrusted). Rendering it inside the app's own origin
 * would give it the session, the cookies and the API — which is the whole
 * workspace.
 *
 * Two mechanisms, and BOTH are required:
 *
 *   - The embedding `<iframe>` carries `sandbox="allow-scripts"` WITHOUT
 *     `allow-same-origin`. Those two together are not a sandbox at all: the
 *     frame gets the embedder's real origin back and can reach straight into
 *     it. Omitting `allow-same-origin` gives the frame an opaque origin, so
 *     `document.cookie` and `localStorage` are inaccessible even to a script
 *     that runs.
 *
 *   - The CSP below denies everything by default and never restores
 *     `connect-src`, so a script inside the frame cannot exfiltrate what it can
 *     see. Scripts and styles are allowed inline because that is what an
 *     artifact is made of; with no network and an opaque origin, there is
 *     nothing for them to reach.
 *
 * `frame-ancestors 'self'` stops the route being embedded by anyone else.
 */

const CSP = [
  "default-src 'none'",
  // An artifact is inline script and inline style by construction.
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  // Inlined data only. No remote images, so no pixel that phones home.
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  // The important one. Never widen this.
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join('; ')

const RENDERABLE = new Set(['html', 'htm', 'svg'])

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('sessionId')
  const path = url.searchParams.get('path')

  if (!sessionId || !path) {
    return new Response('sessionId and path are required', { status: 400 })
  }

  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (!RENDERABLE.has(extension)) {
    return new Response('Not a renderable artifact', { status: 415 })
  }

  const session = await getSession(sessionId)

  let body: string
  try {
    // Confinement to the workspace root is enforced by the Workspace seam, not
    // re-checked here — a second implementation of path safety is a second
    // place for it to be wrong.
    body = await session.workspace.read(path)
  } catch {
    return new Response('Not found', { status: 404 })
  }

  return new Response(body, {
    headers: {
      'Content-Type': extension === 'svg' ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      // Without this a file the model named `.html` but filled with something
      // else could still be sniffed into an executable type.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      // Belt and braces: the CSP already forbids framing from elsewhere.
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
