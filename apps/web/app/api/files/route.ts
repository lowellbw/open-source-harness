import { getSession } from '@/lib/session'

export const runtime = 'nodejs'

/** Lists the workspace, or reads one file. */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('sessionId') ?? 'default'
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
  const sessionId = String(form.get('sessionId') ?? 'default')
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
