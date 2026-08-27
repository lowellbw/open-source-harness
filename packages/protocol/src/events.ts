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

  // ---- steps ----
  /**
   * One model request inside a turn.
   *
   * A turn that calls three tools is four requests, and until now the UI showed
   * it as one undifferentiated wait. These carry what actually varies per step:
   * which tools were offered, what came back, what it cost. `stepNumber` is
   * zero-based, matching the SDK.
   */
  z.object({
    ...base,
    type: z.literal('step.started'),
    stepNumber: z.number().int().nonnegative(),
    /** Undefined means every registered tool was sent. */
    activeTools: z.array(z.string()).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('step.finished'),
    stepNumber: z.number().int().nonnegative(),
    cost: costBucketsSchema,
    toolCalls: z.number().int().nonnegative(),
    /** Wall-clock for the step. What a timeline is actually about. */
    durationMs: z.number().nonnegative().optional(),
    /**
     * Optional because the SDK does not populate it consistently: present on
     * `finish-step` from a live provider, absent from the same part under a
     * mock. A trace showing nothing beats one showing a fabricated value.
     */
    finishReason: z.string().optional(),
  }),

  // ---- subagents ----
  /**
   * A read-only scout, started and finished.
   *
   * Only these two events cross the boundary — deliberately. Forwarding a
   * scout's whole stream would put its transcript in front of the reader, which
   * is the same cost the scout exists to avoid, moved from the model's context
   * to the person's attention. What the parent needs is: what was asked, what
   * it cost, and what came back.
   */
  z.object({
    ...base,
    type: z.literal('subagent.started'),
    subagentId: z.string(),
    task: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('subagent.finished'),
    subagentId: z.string(),
    cost: costBucketsSchema,
    stoppedBy: z.enum(['complete', 'budget_exceeded', 'error']),
    reportChars: z.number().int().nonnegative(),
  }),

  // ---- sources ----
  /**
   * A page the model cited.
   *
   * First-class because provider-side web search leaves no other trace: it runs
   * inside the model request, so there is no tool call to render and no tool
   * result to inspect. Without this event a searched answer is
   * indistinguishable from an asserted one, which is the difference between a
   * citation the reader can check and a claim they cannot.
   */
  z.object({
    ...base,
    type: z.literal('source.cited'),
    messageId: z.string(),
    url: z.string(),
    title: z.string(),
  }),

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
  /**
   * `delta` is this single request's cost, which the run and session totals
   * cannot be decomposed back into. The ledger needs the per-request row — a
   * total is not a record of what was spent, only of how much.
   */
  z.object({
    ...base,
    type: z.literal('cost.updated'),
    run: costBucketsSchema,
    session: costBucketsSchema,
    delta: costBucketsSchema,
    model: z.string(),
  }),

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
