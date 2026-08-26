import { isReasoning, type Message, type ReasoningPart } from '@workspace/protocol'

/**
 * Provider reasoning artifacts across a model switch (PLAN-V2 §6.5).
 *
 * The rule is not "strip reasoning". Each provider's artifacts are meaningful
 * only to that provider, and the failure modes are asymmetric:
 *
 *  - Replaying provider A's signed reasoning to provider B is at best ignored
 *    and at worst rejected, so foreign artifacts must go.
 *  - Google's thought signatures HARD-FAIL when a conversation that had them is
 *    replayed to Google without them. Dropping them is not a degradation, it is
 *    an error — so we detect it and say so loudly rather than shipping a
 *    request we know will be rejected.
 *
 * Rules informed by reading Mastra's Apache-2.0 `ProviderHistoryCompat`, which
 * encodes the same asymmetries. Reimplemented, not copied.
 */

export class ReasoningIntegrityError extends Error {
  constructor(
    readonly provider: string,
    readonly droppedCount: number,
  ) {
    super(
      `Refusing to send ${provider} history with ${droppedCount} reasoning artifact(s) removed: ` +
        `${provider} rejects conversations whose thought signatures are missing. ` +
        `Switch models at a compaction boundary so the reasoning is summarised away rather than stripped.`,
    )
    this.name = 'ReasoningIntegrityError'
  }
}

/**
 * Providers that reject a conversation when their own reasoning artifacts have
 * been removed. Compared post-normalisation, which already folds vertex into
 * google — so this set holds normalised vendors only.
 */
const STRICT_REPLAY_PROVIDERS = new Set(['google'])

export interface StripResult {
  messages: Message[]
  /** Artifacts removed because they belonged to a different provider. */
  strippedForeign: number
  /** Artifacts belonging to the target that were removed. Dangerous — see above. */
  strippedOwn: number
}

/**
 * Removes reasoning parts that the target provider cannot accept.
 *
 * Deliberately does not touch the target's own artifacts: those are what make a
 * replay valid.
 */
export function stripForeignReasoning(messages: Message[], targetProvider: string): StripResult {
  let strippedForeign = 0

  const out = messages.map((message) => {
    const kept = message.parts.filter((part) => {
      if (!isReasoning(part)) return true
      if (sameProvider(part.provider, targetProvider)) return true
      strippedForeign++
      return false
    })

    // Preserve identity when nothing changed, so callers can cheaply detect a
    // no-op and skip re-serialising.
    return kept.length === message.parts.length ? message : { ...message, parts: kept }
  })

  return { messages: out, strippedForeign, strippedOwn: 0 }
}

/**
 * Guards the case that hard-fails.
 *
 * Compares what the history originally carried against what is about to be
 * sent. If the target is strict about replay and its own artifacts have gone
 * missing, refuse — a loud error here is far better than an opaque provider
 * rejection mid-run, which is what §6.5 means by "hard-fail if dropped".
 */
export function assertReplayable(
  original: Message[],
  outgoing: Message[],
  targetProvider: string,
): void {
  if (!STRICT_REPLAY_PROVIDERS.has(normalise(targetProvider))) return

  const before = countOwnSignatures(original, targetProvider)
  const after = countOwnSignatures(outgoing, targetProvider)

  if (after < before) {
    throw new ReasoningIntegrityError(targetProvider, before - after)
  }
}

/**
 * Whether a model switch is safe at this point in the conversation.
 *
 * §6.5: switch only at compaction boundaries, where the cache miss is already
 * sunk. Mid-conversation switching is not merely expensive — it is where
 * artifact mismatches bite, because history still carries the previous
 * provider's reasoning.
 */
export function isSwitchSafe(options: {
  fromProvider: string
  toProvider: string
  atCompactionBoundary: boolean
}): { safe: boolean; reason?: string } {
  if (sameProvider(options.fromProvider, options.toProvider)) return { safe: true }
  if (options.atCompactionBoundary) return { safe: true }
  return {
    safe: false,
    reason:
      'Cross-provider switch outside a compaction boundary: prior reasoning artifacts are still in history, ' +
      'and the cache miss is not yet sunk. Compact first, then switch.',
  }
}

/**
 * Prepares history for a target provider in one step.
 *
 * Returns the messages to send plus what was removed, so the caller can emit a
 * `model.switched` event carrying honest detail rather than a bare flag.
 */
export function prepareForProvider(
  messages: Message[],
  targetProvider: string,
): StripResult {
  const result = stripForeignReasoning(messages, targetProvider)
  assertReplayable(messages, result.messages, targetProvider)
  return result
}

function countOwnSignatures(messages: Message[], provider: string): number {
  let count = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (isReasoning(part) && sameProvider(part.provider, provider) && hasSignature(part)) {
        count++
      }
    }
  }
  return count
}

function hasSignature(part: ReasoningPart): boolean {
  return typeof part.signature === 'string' && part.signature.length > 0
}

/**
 * Google's models are reachable as "google", "vertex" and via gateways that
 * prefix the vendor, so compare on a normalised vendor rather than an exact
 * string. Getting this wrong would strip a provider's own artifacts and trip
 * the very hard-fail this module exists to prevent.
 */
function sameProvider(a: string, b: string): boolean {
  return normalise(a) === normalise(b)
}

function normalise(provider: string): string {
  const vendor = provider.includes('/') ? provider.split('/')[0]! : provider
  const lower = vendor.toLowerCase()
  if (lower === 'vertex' || lower === 'google-vertex') return 'google'
  return lower
}
