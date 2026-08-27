import { manager } from '@/lib/session'

export const runtime = 'nodejs'

/**
 * The thread list.
 *
 * Reads the store rather than the live session map: a thread you have not
 * opened since restarting has no session, and would otherwise vanish from its
 * own list.
 */
export async function GET() {
  return Response.json({ threads: manager.listThreads() })
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: string; modelAlias?: string }
  const { id } = manager.createThread(body.title, body.modelAlias)
  return Response.json({ id }, { status: 201 })
}
