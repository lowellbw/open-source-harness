import { getSession } from '@/lib/session'
import type { WorkspaceEvent } from '@workspace/protocol'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Streams a turn as server-sent events.
 *
 * The wire format is our own WorkspaceEvent union, which is the protocol both
 * shells speak (§4). `toAgUi()` exists in the protocol package for external
 * consumers; nothing internal needs it.
 *
 * SSE rather than WebSockets: the traffic is one-directional and, on the hosted
 * path, must cross an iframe boundary without touching the host's connect-src.
 */
export async function POST(req: Request) {
  const { sessionId, message, modelAlias } = (await req.json()) as {
    sessionId: string
    message: string
    modelAlias?: string
  }

  const session = await getSession(sessionId, modelAlias ?? 'Standard')
  if (modelAlias && modelAlias !== session.modelAlias) {
    try {
      session.agent.switchModel(modelAlias, { atCompactionBoundary: true })
      session.modelAlias = modelAlias
    } catch {
      // A refused switch is not a failed turn; keep the current model.
    }
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false

      /**
       * A disconnected client leaves the controller closed while the agent is
       * still working, and the next event throws ERR_INVALID_STATE. Losing a
       * frame nobody is reading is fine; taking down the turn is not — the
       * agent may be mid-tool-call with real side effects.
       */
      const send = (event: WorkspaceEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      session.listeners.add(send)
      try {
        await session.agent.send(message)
      } finally {
        session.listeners.delete(send)
        if (!closed) {
          closed = true
          try {
            controller.enqueue(encoder.encode('data: {"type":"__done"}\n\n'))
            controller.close()
          } catch {
            // Client already gone.
          }
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer will silently break streaming.
      'X-Accel-Buffering': 'no',
    },
  })
}
