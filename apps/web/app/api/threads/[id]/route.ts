import { manager, store } from '@/lib/session'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

/**
 * A thread's transcript, for rendering it after a restart.
 *
 * Deliberately does NOT call `manager.get(id)`. Opening a thread in the sidebar
 * would otherwise spin up a workspace, bring up every MCP connector and
 * construct an agent — for a read. The session is created when you send
 * something, which is the first moment it is needed.
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const thread = store.getThread(id)
  if (!thread) return Response.json({ error: 'No such thread' }, { status: 404 })

  return Response.json({
    thread,
    messages: store.loadMessages(id),
    cost: store.threadCost(id),
  })
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { title?: string }
  if (typeof body.title === 'string' && body.title.trim()) {
    manager.renameThread(id, body.title.trim().slice(0, 200))
  }
  return Response.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params
  // Goes through the manager, not the store: a live session holds a workspace
  // directory and an agent, and deleting only the rows leaves both orphaned.
  await manager.deleteThread(id)
  return Response.json({ ok: true })
}
