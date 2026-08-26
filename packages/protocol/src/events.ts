import { z } from 'zod'
import { costBucketsSchema } from './cost.js'

/**
 * The internal event contract between the agent core and any shell.
 *
 * PLAN-V2 §4 designates AG-UI as the wire format. We deliberately do NOT import
 * AG-UI's types as our internal contract: `@ag-ui/core` is still 0.0.58 after
 * sixteen months, and it sits between the core and BOTH shells. Owning the union
 * here and projecting to AG-UI at the edge (see ./agui.ts) keeps wire
 * compatibility while making an upstream breaking change cost one file instead
 * of two shells.
 *
 * It also carries domain events AG-UI has no native shape for — approvals,
 * compaction, model switches, cost — which project onto AG-UI's CUSTOM event.
 */

const base = { runId: z.string(), ts: z.number().int() }

/** Coarse agent state, for a status line. */
export const agentStateSchema = z.enum([
  'idle',
  'thinking',
  'calling_tool',
  'awaiting_approval',
  'compacting',
])
export type AgentState = z.infer<typeof agentStateSchema>

export const workspaceEventSchema = z.discriminatedUnion('type', [
  // ---- run lifecycle ----
  z.object({ ...base, type: z.literal('run.started'), threadId: z.string() }),
  z.object({
    ...base,
    type: z.literal('run.finished'),
    reason: z.enum(['complete', 'aborted', 'error', 'budget_exceeded']),
  }),
  z.object({ ...base, type: z.literal('run.error'), message: z.string() }),
  z.object({ ...base, type: z.literal('status'), state: agentStateSchema }),

  // ---- assistant output ----
  z.object({ ...base, type: z.literal('message.started'), messageId: z.string() }),
  z.object({ ...base, type: z.literal('message.delta'), messageId: z.string(), delta: z.string() }),
  z.object({ ...base, type: z.literal('message.finished'), messageId: z.string() }),

  // ---- reasoning ----
  z.object({ ...base, type: z.literal('reasoning.delta'), messageId: z.string(), delta: z.string() }),
  /**
   * Opaque provider reasoning artifact — an Anthropic signed thinking block, an
   * OpenAI reasoning item, a Gemini thought signature. Carried verbatim and
   * never re-rendered. Dropping one across a model switch is what makes Gemini
   * hard-fail (§6.5), so it is a first-class event rather than metadata.
   */
  z.object({
    ...base,
    type: z.literal('reasoning.artifact'),
    messageId: z.string(),
    provider: z.string(),
    value: z.string(),
  }),

  // ---- tools ----
  z.object({ ...base, type: z.literal('tool.call.started'), toolCallId: z.string(), name: z.string(), args: z.unknown() }),
  z.object({ ...base, type: z.literal('tool.call.finished'), toolCallId: z.string(), result: z.unknown(), isError: z.boolean() }),

  // ---- approvals ----
  /**
   * `irreversible` is the gate, not a hint. §9: approvals are shown for
   * irreversibility only — prompting on everything trains people to click
   * through, which is worse than not prompting.
   */
  z.object({
    ...base,
    type: z.literal('approval.requested'),
    approvalId: z.string(),
    toolCallId: z.string(),
    reason: z.string(),
    irreversible: z.boolean(),
    payload: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.resolved'),
    approvalId: z.string(),
    decision: z.enum(['allow', 'deny']),
  }),

  // ---- context management ----
  /**
   * §9 requires compaction be recorded as an explicit event rather than
   * happening invisibly — it is both a debugging surface and the boundary at
   * which a model switch is cheap (§6.5).
   */
  z.object({
    ...base,
    type: z.literal('context.compacted'),
    strategy: z.string(),
    beforeMessages: z.number().int().nonnegative(),
    afterMessages: z.number().int().nonnegative(),
    beforeTokens: z.number().int().nonnegative(),
    afterTokens: z.number().int().nonnegative(),
  }),

  // ---- model ----
  z.object({
    ...base,
    type: z.literal('model.switched'),
    from: z.string(),
    to: z.string(),
    atCompactionBoundary: z.boolean(),
  }),

  // ---- cost ----
  z.object({ ...base, type: z.literal('cost.updated'), run: costBucketsSchema, session: costBucketsSchema }),

  // ---- workspace ----
  z.object({
    ...base,
    type: z.literal('workspace.file.changed'),
    path: z.string(),
    op: z.enum(['created', 'modified', 'deleted']),
  }),
])

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>
export type WorkspaceEventType = WorkspaceEvent['type']

/** Narrow a parsed event by type, with the payload typed. */
export type EventOf<T extends WorkspaceEventType> = Extract<WorkspaceEvent, { type: T }>

export function parseEvent(input: unknown): WorkspaceEvent {
  return workspaceEventSchema.parse(input)
}

export function isEvent<T extends WorkspaceEventType>(
  event: WorkspaceEvent,
  type: T,
): event is EventOf<T> {
  return event.type === type
}
