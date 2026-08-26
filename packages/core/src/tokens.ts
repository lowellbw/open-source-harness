import type { Message, Part } from '@workspace/protocol'

/**
 * Cheap local token estimation.
 *
 * Deliberately an estimate. Its only job is deciding *when* to compact, which
 * is a local scheduling decision that must be made before any request is sent
 * and cannot wait on a network round trip. Actual spend always comes from the
 * provider's own usage report via the meter — never from this.
 *
 * §6.5 notes Anthropic and Google expose token-count endpoints and OpenAI does
 * not, which is the other reason not to depend on a remote count here: the
 * behaviour would differ by provider for a decision that should not.
 */

/** Rough bytes-per-token for English text across current tokenisers. */
const CHARS_PER_TOKEN = 4

/**
 * Per-message overhead for role markers and delimiters. Small, but a long
 * conversation of short messages otherwise under-counts badly.
 */
const MESSAGE_OVERHEAD_TOKENS = 4

export function estimateTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS
    for (const part of message.parts) total += estimatePartTokens(part)
  }
  return total
}

export function estimateMessageTokens(message: Message): number {
  return MESSAGE_OVERHEAD_TOKENS + message.parts.reduce((n, p) => n + estimatePartTokens(p), 0)
}

function estimatePartTokens(part: Part): number {
  switch (part.type) {
    case 'text':
      return charsToTokens(part.text.length)
    case 'reasoning':
      // The signature is an opaque blob that still occupies the request. It is
      // usually the larger half, so ignoring it would badly under-count exactly
      // the conversations most likely to need compaction.
      return charsToTokens(part.text.length + (part.signature?.length ?? 0))
    case 'tool-call':
      return charsToTokens(part.toolName.length + jsonLength(part.input))
    case 'tool-result':
      return charsToTokens(part.toolName.length + jsonLength(part.output))
  }
}

function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function jsonLength(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    // Circular tool payloads must not break a size estimate.
    return String(value).length
  }
}
