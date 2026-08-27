import { getSession } from '@/lib/session'

export const runtime = 'nodejs'

/** Lists the workspace, or reads one file. */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) return badRequest()
  const target = url.searchParams.get('path') ?? '/'
  const download = url.searchParams.get('download') === '1'
  const session = await getSession(sessionId)

  if (download) {
    const bytes = await session.workspace.readBytes(target)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${target.split('/').pop() ?? 'file'}"`,
      },
    })
  }

  const entries = await session.workspace.list(target)
  return Response.json({
    path: target,
    // Internal bookkeeping, not the user's work.
    entries: entries.filter((e) => e.name !== '.elided'),
  })
}

/** Uploads a file into the workspace. */
export async function POST(req: Request) {
  const form = await req.formData()
  const sessionId = String(form.get('sessionId') ?? '')
  if (!sessionId) return badRequest()
  const file = form.get('file')

  if (!(file instanceof File)) {
    return Response.json({ ok: false, reason: 'No file provided' }, { status: 400 })
  }

  const session = await getSession(sessionId)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const target = `/${file.name}`
  await session.workspace.write(target, bytes)

  for (const listener of session.listeners) {
    listener({ type: 'workspace.file.changed', runId: 'ui', ts: Date.now(), path: target, op: 'created' })
  }
  return Response.json({ ok: true, path: target, size: bytes.length })
}

/**
 * No implicit thread.
 *
 * These routes used to fall back to a session called "default". That is worse
 * than a 400: it silently materialises a workspace and a conversation for a
 * caller that did not name one, and a client rendering before it has picked a
 * thread creates a real thread it can never open again.
 */
function badRequest(): Response {
  return Response.json({ error: 'sessionId is required' }, { status: 400 })
}
