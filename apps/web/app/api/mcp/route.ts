import { getSession } from '@/lib/session'

export const runtime = 'nodejs'

/**
 * Connector status and the approval surface for MCP tools.
 *
 * Tools arrive unapproved and are not callable until a human has read what they
 * claim to do (§11). A tool whose description changes after approval is
 * reported separately from one never seen: the first means something you
 * trusted has moved, which is the stronger signal.
 */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get('sessionId') ?? 'default'
  const { connectors: mcp } = await getSession(sessionId)

  const pending = mcp.toolset.needingApproval()
  const approved = mcp.toolset.callable()

  return Response.json({
    servers: mcp.servers,
    errors: mcp.errors,
    approved: approved.map((t) => ({ name: t.qualifiedName, serverId: t.serverId })),
    pending: pending.map((t) => ({
      name: t.name,
      qualifiedName: t.qualifiedName,
      serverId: t.serverId,
      description: t.description ?? '',
      status: t.status,
    })),
  })
}

/** Approves one tool at its current description, or all pending ones. */
export async function POST(req: Request) {
  const { sessionId, qualifiedName, all } = (await req.json()) as {
    sessionId: string
    qualifiedName?: string
    all?: boolean
  }

  const { connectors: mcp } = await getSession(sessionId ?? 'default')
  const pending = mcp.toolset.needingApproval()
  const targets = all ? pending : pending.filter((t) => t.qualifiedName === qualifiedName)

  if (targets.length === 0) {
    return Response.json({ ok: false, reason: 'Nothing pending matched' }, { status: 404 })
  }

  for (const target of targets) {
    mcp.approvals.approve(target.serverId, {
      name: target.name,
      description: target.description,
      inputSchema: target.inputSchema,
    })
  }
  await mcp.save()

  // Statuses are computed at discovery, so re-run it to pick up the approvals.
  return Response.json({ ok: true, approved: targets.map((t) => t.qualifiedName) })
}
