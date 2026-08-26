import { z } from 'zod'

/**
 * Our own conversation model.
 *
 * ADR-0001 takes a narrow slice of the AI SDK; this is part of what keeps the
 * slice narrow. Conversion to the SDK's message types happens once, at the call
 * boundary, so SDK churn — real, given v5 to v7 inside a year — lands in one
 * adapter rather than throughout the condenser, the pinning logic and the
 * artifact rules.
 *
 * The important departure from a naive model: provider reasoning artifacts are
 * explicit and carry their provider. They cannot be treated as opaque text
 * because whether one may be replayed depends entirely on which provider is
 * about to receive it (§6.5).
 */

export const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const reasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  /** Human-readable reasoning, where the provider exposes it. */
  text: z.string().default(''),
  /**
   * Which provider produced this. Load-bearing: replaying one provider's
   * reasoning to another is at best ignored and at worst a hard error.
   */
  provider: z.string(),
  /**
   * The opaque artifact — an Anthropic signed thinking block, an OpenAI
   * reasoning item, a Gemini thought signature. Never rendered, never edited,
   * round-tripped verbatim or dropped as a unit.
   */
  signature: z.string().optional(),
})

export const toolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
})

export const toolResultPartSchema = z.object({
  type: z.literal('tool-result'),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.unknown(),
  isError: z.boolean().default(false),
  /**
   * Set when the real output was swapped for a path reference during
   * compaction. Lossless in the sense that matters — the agent can re-read the
   * file — and marked so the UI can say so.
   */
  elidedTo: z.string().optional(),
})

export const partSchema = z.discriminatedUnion('type', [
  textPartSchema,
  reasoningPartSchema,
  toolCallPartSchema,
  toolResultPartSchema,
])

export const roleSchema = z.enum(['system', 'user', 'assistant', 'tool'])

export const messageSchema = z.object({
  id: z.string(),
  role: roleSchema,
  parts: z.array(partSchema),
  /**
   * Messages marked pinned are re-injected on every request and are never
   * eligible for compaction. This is the mechanism behind the constraint-decay
   * mitigation; see the condenser.
   */
  pinned: z.boolean().default(false),
})

export type TextPart = z.infer<typeof textPartSchema>
export type ReasoningPart = z.infer<typeof reasoningPartSchema>
export type ToolCallPart = z.infer<typeof toolCallPartSchema>
export type ToolResultPart = z.infer<typeof toolResultPartSchema>
export type Part = z.infer<typeof partSchema>
export type Role = z.infer<typeof roleSchema>
export type Message = z.infer<typeof messageSchema>

export function textOf(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

export function isReasoning(part: Part): part is ReasoningPart {
  return part.type === 'reasoning'
}
