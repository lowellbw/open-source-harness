import type { ModelMessage } from 'ai'
import type { Message } from '@workspace/protocol'

/**
 * Converts our conversation model into the AI SDK's message types.
 *
 * ADR-0001 keeps the slice of the SDK narrow, and this file is where that pays
 * off: SDK message-shape churn — real, given v5 to v7 inside a year — lands
 * here and nowhere else. The condenser, the pinning logic and the artifact
 * rules all work on our own types and never see this.
 *
 * System messages are deliberately NOT emitted. The SDK rejects them in the
 * message array unless `allowSystemInMessages` is set, and routing pinned
 * policy through `instructions` instead is the stronger arrangement anyway:
 * the constraint lives structurally outside the array that compaction edits,
 * rather than merely first within it.
 */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = []

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        // Carried via `instructions`. See above.
        continue

      case 'user': {
        const text = joinText(message)
        if (text) out.push({ role: 'user', content: text })
        break
      }

      case 'assistant': {
        const content = assistantContent(message)
        if (content.length > 0) out.push({ role: 'assistant', content })
        break
      }

      case 'tool': {
        const content = toolContent(message)
        if (content.length > 0) out.push({ role: 'tool', content })
        break
      }
    }
  }

  return out
}

/** Renders the pinned messages into the `instructions` string. */
export function toInstructions(pinned: Message[]): string {
  return pinned.map(joinText).filter(Boolean).join('\n\n')
}

/**
 * Converts the SDK's message array back into our model.
 *
 * Needed because `prepareStep` must transform *what the SDK is about to send*,
 * not substitute a separately-maintained history. Mid-loop the SDK's array
 * already contains this turn's tool calls and their results; replacing it with
 * our own record would drop them and the agent would loop forever re-asking for
 * a tool it had already run.
 *
 * So the flow is: SDK messages in, our types, condense, our types out. The
 * condenser and artifact rules never learn the SDK exists.
 */
export function fromModelMessages(messages: ModelMessage[]): Message[] {
  return messages.map((message, index) => {
    const id = `sdk-${index}`

    if (message.role === 'system') {
      return { id, role: 'system', pinned: false, parts: [{ type: 'text', text: asText(message.content) }] }
    }

    if (message.role === 'user') {
      return { id, role: 'user', pinned: false, parts: [{ type: 'text', text: asText(message.content) }] }
    }

    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        return { id, role: 'assistant', pinned: false, parts: [{ type: 'text', text: message.content }] }
      }
      const parts: Message['parts'] = []
      for (const part of message.content) {
        if (part.type === 'text') parts.push({ type: 'text', text: part.text })
        else if (part.type === 'reasoning') {
          parts.push({ type: 'reasoning', text: part.text, provider: 'unknown' })
        } else if (part.type === 'tool-call') {
          parts.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
        }
      }
      return { id, role: 'assistant', pinned: false, parts }
    }

    const parts: Message['parts'] = []
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue
      parts.push({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: unwrapOutput(part.output),
        isError: false,
      })
    }
    return { id, role: 'tool', pinned: false, parts }
  })
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => (p as { type?: string })?.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

function unwrapOutput(output: unknown): unknown {
  const wrapped = output as { type?: string; value?: unknown }
  return wrapped && typeof wrapped === 'object' && 'value' in wrapped ? wrapped.value : output
}

function assistantContent(message: Message): Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> {
  const parts: Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> = []

  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text) parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'reasoning') {
      // Only emitted when it carries text. A bare signature has no SDK-level
      // representation here; the artifact rules decide whether it may travel
      // at all, and dropping one for the wrong provider is the failure they
      // exist to prevent.
      if (part.text) parts.push({ type: 'reasoning', text: part.text })
    } else if (part.type === 'tool-call') {
      parts.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    }
  }

  return parts
}

function toolContent(message: Message): Extract<ModelMessage, { role: 'tool' }>['content'] {
  const parts: Extract<ModelMessage, { role: 'tool' }>['content'] = []

  for (const part of message.parts) {
    if (part.type !== 'tool-result') continue
    parts.push({
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output:
        typeof part.output === 'string'
          ? { type: 'text', value: part.output }
          : { type: 'json', value: part.output as never },
    })
  }

  return parts
}

function joinText(message: Message): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
