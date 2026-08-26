import type { Message, ToolResultPart } from '@workspace/protocol'
import { estimateTokens } from './tokens.js'

/**
 * The condenser (PLAN-V2 §9).
 *
 * Two rules govern it, and both come from evidence rather than taste:
 *
 * 1. **Pinned messages are never compacted.** Compaction demonstrably evicts
 *    policy constraints — safety-rule recall falls to 10% by the fifth round
 *    (Zerhoudi et al., arXiv:2608.22752, CIKM '26). Anything pinned is
 *    partitioned out before any strategy runs and rejoined afterwards.
 *
 * 2. **Compaction before summarisation.** Replacing a large tool output with a
 *    reference to the file holding it is lossless: the agent can re-read it,
 *    and exact strings — paths, line numbers, error text — survive. Summarising
 *    paraphrases and cannot promise that. So the cheap lossless pass runs
 *    first, and summarisation is the fallback only when it is not enough.
 */

export interface CondenserOptions {
  /** Compaction runs when the estimate exceeds this. */
  maxTokens: number
  /** Messages at the tail always kept verbatim. */
  keepRecent: number
  /** Messages at the head of compactable history kept verbatim (the task). */
  keepFirst: number
  /** Tool outputs longer than this many characters become references. */
  elideToolOutputsOverChars: number
  /**
   * Persists a tool output and returns a workspace path for it.
   *
   * Required for the lossless pass to be lossless. Without it that pass is
   * skipped entirely rather than quietly dropping content and calling it
   * compaction.
   */
  persistToolOutput?: (toolCallId: string, output: unknown) => Promise<string>
  /** Lossy fallback. Without it, the condenser does what it can losslessly. */
  summarise?: (messages: Message[]) => Promise<string>
}

export const defaultCondenserOptions: Omit<CondenserOptions, 'maxTokens'> = {
  keepRecent: 6,
  keepFirst: 1,
  elideToolOutputsOverChars: 2_000,
}

export interface CondenseResult {
  messages: Message[]
  compacted: boolean
  /** Which passes ran, for the explicit compaction event §9 requires. */
  strategy: string
  before: { messages: number; tokens: number }
  after: { messages: number; tokens: number }
}

export async function condense(
  input: Message[],
  options: CondenserOptions,
): Promise<CondenseResult> {
  const before = { messages: input.length, tokens: estimateTokens(input) }

  if (before.tokens <= options.maxTokens) {
    return { messages: input, compacted: false, strategy: 'none', before, after: before }
  }

  // Pinned content is partitioned out entirely. It is not merely ordered first
  // or weighted — no strategy below can see it, so none can drop it.
  const pinned = input.filter((m) => m.pinned)
  let history = input.filter((m) => !m.pinned)
  const passes: string[] = []

  if (options.persistToolOutput) {
    const elided = await elideToolOutputs(history, options)
    if (elided.changed) {
      history = elided.messages
      passes.push('elide-tool-outputs')
    }
  }

  let current = [...pinned, ...history]
  if (estimateTokens(current) > options.maxTokens && options.summarise) {
    const summarised = await summariseMiddle(history, options)
    if (summarised.changed) {
      history = summarised.messages
      passes.push('summarise-middle')
      current = [...pinned, ...history]
    }
  }

  const after = { messages: current.length, tokens: estimateTokens(current) }
  return {
    messages: current,
    compacted: passes.length > 0,
    strategy: passes.length > 0 ? passes.join('+') : 'none',
    before,
    after,
  }
}

/**
 * Lossless pass: large tool outputs outside the recent window become file
 * references. The agent can still reach the content; it just is not resident.
 */
async function elideToolOutputs(
  history: Message[],
  options: CondenserOptions,
): Promise<{ messages: Message[]; changed: boolean }> {
  const boundary = recentBoundary(history, options.keepRecent)
  const persist = options.persistToolOutput!
  let changedAny = false

  const out = await Promise.all(
    history.map(async (message, index) => {
      if (index >= boundary) return message

      let changedHere = false
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (part.type !== 'tool-result') return part
          const result = part as ToolResultPart
          if (result.elidedTo) return part

          const size = sizeOf(result.output)
          if (size <= options.elideToolOutputsOverChars) return part

          const path = await persist(result.toolCallId, result.output)
          changedHere = true
          changedAny = true
          return {
            ...result,
            output: `[${size} characters elided to ${path} — read that file to see the full output]`,
            elidedTo: path,
          }
        }),
      )

      // Per-message, so untouched messages keep their identity and callers can
      // cheaply tell what actually moved.
      return changedHere ? { ...message, parts } : message
    }),
  )

  return { messages: out, changed: changedAny }
}

/** Lossy pass: replace the middle with one summary message. */
async function summariseMiddle(
  history: Message[],
  options: CondenserOptions,
): Promise<{ messages: Message[]; changed: boolean }> {
  const boundary = recentBoundary(history, options.keepRecent)
  const head = history.slice(0, options.keepFirst)
  const middle = history.slice(options.keepFirst, boundary)
  const tail = history.slice(boundary)

  // Nothing worth the cost of a summarisation call.
  if (middle.length < 2) return { messages: history, changed: false }

  const summary = await options.summarise!(middle)

  const summaryMessage: Message = {
    id: `summary-${boundary}-${middle.length}`,
    role: 'assistant',
    pinned: false,
    parts: [
      {
        type: 'text',
        text: `[Earlier conversation summarised — ${middle.length} messages]\n\n${summary}`,
      },
    ],
  }

  return { messages: [...head, summaryMessage, ...tail], changed: true }
}

/**
 * Start index of the verbatim tail, adjusted so it never splits a tool call
 * from its result.
 *
 * Providers reject a conversation containing a tool result whose call is
 * missing, so a boundary landing between the two would produce history that
 * cannot be sent at all. The boundary therefore only ever moves earlier —
 * keeping more verbatim is safe, keeping a dangling half is not.
 */
export function recentBoundary(history: Message[], keepRecent: number): number {
  let boundary = Math.max(0, history.length - keepRecent)

  while (boundary > 0) {
    const atBoundary = history[boundary]
    const before = history[boundary - 1]

    // A tool result at the boundary means its call sits before it.
    if (atBoundary && hasToolResult(atBoundary)) {
      boundary--
      continue
    }
    // An assistant message immediately before the boundary that made tool calls
    // must come along, or its results inside the window are orphaned.
    if (before && hasToolCall(before)) {
      boundary--
      continue
    }
    break
  }

  return boundary
}

function hasToolCall(message: Message): boolean {
  return message.parts.some((p) => p.type === 'tool-call')
}

function hasToolResult(message: Message): boolean {
  return message.parts.some((p) => p.type === 'tool-result')
}

function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return String(value).length
  }
}
