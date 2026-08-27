import type { ModelMessage } from 'ai'
import type { Message } from '@workspace/protocol'

/**
 * Reads an attachment's bytes.
 *
 * Injected because the adapter must not know what a workspace is — it is the
 * one file that knows the SDK, and making it also know the execution seam
 * would tie SDK churn to filesystem churn. The session layer supplies it.
 */
export type ReadAttachment = (path: string) => Promise<Uint8Array>

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
        const content = userContent(message)
        if (content.length > 0) {
          // A lone text part goes as a plain string. Every provider accepts the
          // array form, but the string form is what their prompt caches were
          // built around, and an unnecessary array is an unnecessary difference.
          const only = content.length === 1 && content[0]!.type === 'text'
          out.push(
            only
              ? { role: 'user', content: (content[0] as { text: string }).text }
              : { role: 'user', content },
          )
        }
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
      /*
       * Attachments must survive this round trip.
       *
       * `prepareStep` runs `fromModelMessages` on what the SDK is about to send
       * and then converts the result back. A version of this that kept only
       * text stripped every image and file from the FIRST request onwards — so
       * an attached screenshot never reached the model at all, and the only
       * symptom was a reply that made no sense. The bytes are carried through
       * rather than re-read, because the SDK's array is the only place they
       * still exist at this point.
       */
      if (typeof message.content === 'string') {
        return { id, role: 'user', pinned: false, parts: [{ type: 'text', text: message.content }] }
      }

      const parts: Message['parts'] = []
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text })
        } else if (part.type === 'image') {
          parts.push({
            type: 'file',
            mediaType: part.mediaType ?? 'image/png',
            data: toBytes(part.image),
          } as Message['parts'][number])
        } else if (part.type === 'file') {
          parts.push({
            type: 'file',
            mediaType: part.mediaType,
            data: toBytes(part.data),
            ...(part.filename ? { filename: part.filename } : {}),
          } as Message['parts'][number])
        }
      }
      return { id, role: 'user', pinned: false, parts }
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

/**
 * User content, with attachments resolved to data the model can see.
 *
 * Attachments are workspace paths in our model; the SDK wants bytes or a URL.
 * `resolveAttachments` fills in `data` before this runs — this function only
 * shapes what is already there, so a message whose file has since been deleted
 * degrades to a note rather than throwing mid-turn.
 */
function userContent(message: Message): Extract<ModelMessage, { role: 'user' }>['content'] & object {
  const parts: Exclude<Extract<ModelMessage, { role: 'user' }>['content'], string> = []

  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text) parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'file') {
      const data = (part as { data?: Uint8Array }).data
      if (!data) {
        parts.push({
          type: 'text',
          text: `[attachment unavailable: ${part.filename ?? part.path}]`,
        })
        continue
      }
      // The SDK distinguishes image from file, and providers treat them
      // differently — an image goes to the vision path, a PDF to the document
      // path. Sending a PNG as a generic file loses the former.
      if (part.mediaType.startsWith('image/')) {
        parts.push({ type: 'image', image: data, mediaType: part.mediaType })
      } else {
        parts.push({
          type: 'file',
          data,
          mediaType: part.mediaType,
          ...(part.filename ? { filename: part.filename } : {}),
        })
      }
    }
  }

  return parts
}

/**
 * Loads attachment bytes for a set of messages.
 *
 * Separate from `toModelMessages` so the adapter stays synchronous and free of
 * any notion of storage, and so a failed read becomes a visible note in the
 * conversation rather than an exception thrown out of the middle of a turn.
 */
export async function resolveAttachments(
  messages: Message[],
  read: ReadAttachment,
): Promise<Message[]> {
  const anyFiles = messages.some((m) => m.parts.some((p) => p.type === 'file'))
  if (!anyFiles) return messages

  return Promise.all(
    messages.map(async (message) => {
      if (!message.parts.some((p) => p.type === 'file')) return message
      return {
        ...message,
        parts: await Promise.all(
          message.parts.map(async (part) => {
            if (part.type !== 'file') return part
            // Already carries bytes — a part reconstructed mid-turn from the
            // SDK. Re-reading would need a path it does not have.
            if ((part as { data?: Uint8Array }).data) return part
            if (!part.path) return part
            try {
              return { ...part, data: await read(part.path) }
            } catch {
              return part
            }
          }),
        ),
      }
    }),
  )
}

/** Whatever shape the SDK used for binary content, as bytes. */
function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  // A URL or a base64 string cannot be turned back into bytes here, and
  // guessing would produce a corrupt attachment rather than an absent one.
  return undefined
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
