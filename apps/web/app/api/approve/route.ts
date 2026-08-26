import { peekSession } from '@/lib/session'

export const runtime = 'nodejs'

/** Resolves a pending approval. An unanswered prompt times out as a denial. */
export async function POST(req: Request) {
  const { sessionId, approvalId, decision } = (await req.json()) as {
    sessionId: string
    approvalId: string
    decision: 'allow' | 'deny'
  }

  const session = peekSession(sessionId)
  const pending = session?.pending.get(approvalId)
  if (!session || !pending) {
    return Response.json({ ok: false, reason: 'No such pending approval' }, { status: 404 })
  }

  pending.resolve(decision)
  for (const listener of session.listeners) {
    listener({ type: 'approval.resolved', runId: 'ui', ts: Date.now(), approvalId, decision })
  }
  return Response.json({ ok: true })
}
