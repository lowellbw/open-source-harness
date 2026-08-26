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
  const sessionId = new URL(req.url).searchParams.get('sessionId') ?? 'default'
  const session = await getSession(sessionId)

  const available = session.gateway.catalog.listForRole(defaultPolicy.role)
  const floor = session.gateway.catalog.floor()

  return Response.json({
    current: session.modelAlias,
    models: available.map((m) => ({
      alias: m.alias,
      tier: m.tier,
      contextWindow: m.contextWindow,
      inputPerMtok: m.rates.inputPerMtok,
      outputPerMtok: m.rates.outputPerMtok,
      isFloor: m.alias === floor.alias,
    })),
    totals: session.gateway.totals(),
    budget: session.gateway.budget.remaining(),
  })
}
