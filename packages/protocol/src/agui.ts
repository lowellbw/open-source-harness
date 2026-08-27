import { EventType, type BaseEvent } from '@ag-ui/core'
import type { WorkspaceEvent } from './events.js'

/**
 * Projection of our internal event union onto the AG-UI wire format.
 *
 * This is the ONLY file that imports `@ag-ui/core`. Everything upstream speaks
 * our own types (see ./events.ts for why). If AG-UI makes a breaking change —
 * likely, at 0.0.58 — this file absorbs it and neither shell notices.
 */

export interface AgUiContext {
  /** AG-UI requires threadId on run lifecycle events; our union carries it only on run.started. */
  threadId: string
}

/** Domain events AG-UI has no native shape for travel as CUSTOM under these names. */
export const CUSTOM_EVENT_NAMES = {
  approvalRequested: 'workspace.approval.requested',
  approvalResolved: 'workspace.approval.resolved',
  contextCompacted: 'workspace.context.compacted',
  modelSwitched: 'workspace.model.switched',
  costUpdated: 'workspace.cost.updated',
  sourceCited: 'workspace.source.cited',
  fileChanged: 'workspace.file.changed',
  status: 'workspace.status',
} as const

/**
 * Returns an array because the mapping is not one-to-one: some of our events
 * have no AG-UI counterpart worth emitting, and returning `[]` keeps the
 * function total rather than forcing nullable handling at every call site.
 */
export function toAgUi(event: WorkspaceEvent, ctx: AgUiContext): BaseEvent[] {
  const timestamp = event.ts
  const custom = (name: string, value: unknown): BaseEvent[] => [
    { type: EventType.CUSTOM, timestamp, name, value } as BaseEvent,
  ]

  switch (event.type) {
    case 'run.started':
      return [
        {
          type: EventType.RUN_STARTED,
          timestamp,
          threadId: event.threadId,
          runId: event.runId,
        } as BaseEvent,
      ]

    case 'run.finished':
      return [
        {
          type: EventType.RUN_FINISHED,
          timestamp,
          threadId: ctx.threadId,
          runId: event.runId,
          outcome: event.reason,
        } as BaseEvent,
      ]

    case 'run.error':
      return [
        { type: EventType.RUN_ERROR, timestamp, message: event.message } as BaseEvent,
      ]

    case 'message.started':
      return [
        {
          type: EventType.TEXT_MESSAGE_START,
          timestamp,
          messageId: event.messageId,
          role: 'assistant',
        } as BaseEvent,
      ]

    case 'message.delta':
      return [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          timestamp,
          messageId: event.messageId,
          delta: event.delta,
        } as BaseEvent,
      ]

    case 'message.finished':
      return [
        { type: EventType.TEXT_MESSAGE_END, timestamp, messageId: event.messageId } as BaseEvent,
      ]

    case 'reasoning.delta':
      return [
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          timestamp,
          messageId: event.messageId,
          delta: event.delta,
        } as BaseEvent,
      ]

    case 'reasoning.artifact':
      // AG-UI models opaque provider reasoning blobs first-class. Carrying them
      // here rather than as metadata is what lets a shell round-trip them
      // without ever decoding them.
      return [
        {
          type: EventType.REASONING_ENCRYPTED_VALUE,
          timestamp,
          subtype: 'message',
          entityId: event.messageId,
          encryptedValue: event.value,
        } as BaseEvent,
      ]

    case 'tool.call.started':
      return [
        {
          type: EventType.TOOL_CALL_START,
          timestamp,
          toolCallId: event.toolCallId,
          toolCallName: event.name,
        } as BaseEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          timestamp,
          toolCallId: event.toolCallId,
          delta: JSON.stringify(event.args ?? {}),
        } as BaseEvent,
      ]

    case 'tool.call.finished':
      return [
        { type: EventType.TOOL_CALL_END, timestamp, toolCallId: event.toolCallId } as BaseEvent,
        {
          type: EventType.TOOL_CALL_RESULT,
          timestamp,
          messageId: event.toolCallId,
          toolCallId: event.toolCallId,
          // AG-UI types content as a string; ours is unknown.
          content: stringifyResult(event.result),
        } as BaseEvent,
      ]

    // AG-UI has no source or citation event at 0.0.58, so this travels as
    // CUSTOM alongside our other domain events.
    case 'source.cited':
      return custom(CUSTOM_EVENT_NAMES.sourceCited, {
        messageId: event.messageId,
        url: event.url,
        title: event.title,
      })

    case 'approval.requested':
      return custom(CUSTOM_EVENT_NAMES.approvalRequested, {
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        reason: event.reason,
        irreversible: event.irreversible,
        payload: event.payload,
      })

    case 'approval.resolved':
      return custom(CUSTOM_EVENT_NAMES.approvalResolved, {
        approvalId: event.approvalId,
        decision: event.decision,
      })

    case 'context.compacted':
      return custom(CUSTOM_EVENT_NAMES.contextCompacted, {
        strategy: event.strategy,
        beforeMessages: event.beforeMessages,
        afterMessages: event.afterMessages,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
      })

    case 'model.switched':
      return custom(CUSTOM_EVENT_NAMES.modelSwitched, {
        from: event.from,
        to: event.to,
        atCompactionBoundary: event.atCompactionBoundary,
      })

    case 'cost.updated':
      return custom(CUSTOM_EVENT_NAMES.costUpdated, { run: event.run, session: event.session })

    case 'workspace.file.changed':
      return custom(CUSTOM_EVENT_NAMES.fileChanged, { path: event.path, op: event.op })

    case 'status':
      return custom(CUSTOM_EVENT_NAMES.status, { state: event.state })
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result) ?? ''
  } catch {
    // Circular or otherwise unserialisable tool output must not kill the stream.
    return String(result)
  }
}
