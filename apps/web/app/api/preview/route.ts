import { getSession } from '@/lib/session'
import { toImages } from '@workspace/documents'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Renders an office document to page images for the artifact pane.
 *
 * Server-side because no browser reads OOXML, and there is no honest way to
 * pretend otherwise without shipping an office suite to the client. Rendering
 * runs inside the workspace, so on a container backing it happens there rather
 * than on the host — a model-authored document is untrusted input to
 * LibreOffice, which is a large C++ program with a long history of parser bugs.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('sessionId')
  const path = url.searchParams.get('path')

  if (!sessionId || !path) {
    return Response.json({ error: 'sessionId and path are required' }, { status: 400 })
  }

  const session = await getSession(sessionId)
  const rendered = await toImages(session.workspace, path, { maxPages: 12 })

  if (!rendered.ok) {
    return Response.json({ error: rendered.reason ?? 'Could not render' }, { status: 422 })
  }

  return Response.json({
    // Served through the file API rather than inlined as data URLs: a
    // twelve-page render is megabytes, and the browser caches URLs.
    pages: rendered.pages.map(
      (page) =>
        `/api/files?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(page)}`,
    ),
    via: rendered.via,
    // Said out loud so the pane can tell the user it is looking at page one of
    // twenty rather than at a one-page document.
    partial: rendered.via === 'libreoffice',
  })
}
