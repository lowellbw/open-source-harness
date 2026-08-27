import { getSession, defaultPolicy } from '@/lib/session'

export const runtime = 'nodejs'

/**
 * The model picker's source of truth.
 *
 * Returns only what this role may actually use — gating is applied here, in the
 * gateway, not filtered in the client (§4 assumes the UI is bypassed). The
 * floor is flagged so the UI can show it can never be taken away.
 */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get('sessionId')
  if (!sessionId) return badRequest()
  const session = await getSession(sessionId)

  const available = session.gateway.catalog.listForRole(defaultPolicy.role)
  const floor = session.gateway.catalog.floor()

  return Response.json({
    current: session.modelAlias,
    models: available.map((m) => ({
      alias: m.alias,
      tier: m.tier,
      // §6.2 hides provider IDs from end users so an admin can repoint an alias
      // without retraining anyone. The person running this locally IS the
      // admin, and needs to know what is actually being called.
      upstreamModel: m.upstreamModel,
      provider: m.provider,
      contextWindow: m.contextWindow,
      inputPerMtok: m.rates.inputPerMtok,
      outputPerMtok: m.rates.outputPerMtok,
      isFloor: m.alias === floor.alias,
    })),
    totals: session.gateway.totals(),
    budget: session.gateway.budget.remaining(),
  })
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
