import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { costBucketsSchema, workspaceEventSchema } from '@workspace/protocol'

/**
 * Fails when the Swift client falls behind `packages/protocol`.
 *
 * The drift this catches is *silent by construction*. `WorkspaceEvent.swift`
 * decodes an unrecognised `type` to `.unknown` and logs it rather than throwing,
 * deliberately, so that a sidecar newer than the app cannot take the transcript
 * down. `CostBuckets` decodes every field with `decodeIfPresent` for the same
 * reason. The consequence is that a feature the backend has shipped and the Mac
 * app has not caught up to looks exactly like nothing happening — which is how
 * web search, subagents and the step timeline were live for twelve commits while
 * the Mac app rendered none of them and reported nothing.
 *
 * It lives here, inside `apps/mac-shell`, because `vitest.config.ts` globs
 * `apps/**\/*.test.ts` and this is the Mac side of the boundary described in
 * CLAUDE.md. It reads Swift as *text* and never compiles it, which matters: a
 * standing invariant is that this app cannot be built or tested on Linux, and
 * `pnpm test` has to keep working there.
 *
 * The TypeScript side is exact — the Zod schema is introspected, not scraped —
 * so a renamed event cannot slip past by matching a stale regex.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const swiftSource = readFileSync(
  path.join(here, 'Sources/MacShell/WorkspaceEvent.swift'),
  'utf8',
)

/** Every `case "…":` label in the event decoder's switch. */
function decodedEventTypes(): Set<string> {
  return new Set(
    [...swiftSource.matchAll(/^\s*case "([a-z_.]+)":/gm)].map((match) => match[1]!),
  )
}

/** Every property name in `CostBuckets`. */
function swiftCostBuckets(): Set<string> {
  const block = swiftSource.match(/struct CostBuckets[\s\S]*?\n}/)?.[0] ?? ''
  return new Set(
    [...block.matchAll(/^\s{4}var ([A-Za-z]+):/gm)].map((match) => match[1]!),
  )
}

describe('the Swift client tracks packages/protocol', () => {
  it('decodes every event type in the union', () => {
    const declared = workspaceEventSchema.options.map(
      (option) => option.shape.type.value as string,
    )
    const decoded = decodedEventTypes()

    const missing = declared.filter((type) => !decoded.has(type))

    expect(
      missing,
      missing.length === 0
        ? ''
        : `WorkspaceEvent.swift has no case for: ${missing.join(', ')}.\n` +
          'These decode to .unknown and render as nothing at all, so the Mac app ' +
          'looks like the feature does not exist rather than like it is missing. ' +
          'Add a case to the decoder. If it is deliberately not rendered, decode it ' +
          'to .unknown explicitly with a comment saying why, as reasoning.artifact ' +
          'does — an explicit case still satisfies this test.',
    ).toEqual([])
  })

  it('carries every cost bucket', () => {
    const declared = Object.keys(costBucketsSchema.shape)
    const swift = swiftCostBuckets()

    const missing = declared.filter((bucket) => !swift.has(bucket))

    expect(
      missing,
      missing.length === 0
        ? ''
        : `CostBuckets in WorkspaceEvent.swift is missing: ${missing.join(', ')}.\n` +
          'Missing buckets decode to zero rather than failing, so the meter ' +
          'understates instead of erroring — and `usd` stops reconciling against ' +
          'the token breakdown.',
    ).toEqual([])
  })

  it('still decodes the stream sentinel the chat route emits', () => {
    // `__done` is not part of the Zod union — it is the SSE terminator written by
    // apps/web/app/api/chat/route.ts. It is asserted here because nothing else
    // would notice if it were renamed.
    expect(decodedEventTypes().has('__done')).toBe(true)
  })
})
