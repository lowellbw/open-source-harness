import { peekSession } from '@/lib/session'

export const runtime = 'nodejs'

/** Resolves a pending approval. An unanswered prompt times out as a denial. */
export async function POST(req: Request) {
  const { sessionId, approvalId, decision } = (await req.json()) as {
    sessionId: string
    approvalId: string
    decision: 'allow' | 'deny' | 'session'
  }

  const session = peekSession(sessionId)
  // The gate emits approval.resolved itself, so every connected shell clears
  // its prompt without this route knowing who is listening.
  if (!session?.approvals.resolve(approvalId, decision)) {
    return Response.json(
      { ok: false, reason: 'No such pending approval — already answered, or timed out' },
      { status: 404 },
    )
  }
  return Response.json({ ok: true })
}
