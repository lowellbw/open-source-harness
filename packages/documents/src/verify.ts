import type { Workspace } from '@workspace/workspace'
import { toImages, toPdf } from './render.js'

/**
 * The three gates (PLAN-V2 §10, §14).
 *
 * The product is the verification, not the generation. Anyone can emit a
 * .pptx; the question is whether what comes out is something you would put in
 * front of a minister. Each gate catches a class of fault the others cannot.
 *
 *   1. STRUCTURE. Is it a well-formed OOXML package — the right content types,
 *      the relationships resolving, every part present and parseable? Catches
 *      a file that will not open at all.
 *
 *   2. RECALCULATE. Does an office suite open it and write it back out?
 *      LibreOffice doing a real parse and a real layout pass catches formulas
 *      that do not evaluate and relationships that point at nothing — faults
 *      that are invisible to gate 1 because the document is schema-valid and
 *      still wrong.
 *
 *   3. LOOK AT IT. Rasterise, and hand the image to a subagent with NO memory
 *      of authoring it. This is the one that matters, and the one everyone
 *      skips. A deck can be well-formed, recalculate cleanly, and have its
 *      third bullet running off the bottom of the slide, a chart with no
 *      legend, or white text on a white background. Gates 1 and 2 pass it
 *      happily. Only looking catches it.
 *
 * The fresh subagent is not incidental. An agent asked to check its own work
 * grades what it MEANT to produce; it knows there were meant to be six bullets
 * and reads six. One that has never seen the spec sees five bullets and half
 * of a sixth, and says so.
 */

export type GateName = 'structure' | 'recalculate' | 'appearance'

export interface GateResult {
  gate: GateName
  passed: boolean
  detail: string
}

export interface VerifyResult {
  ok: boolean
  gates: GateResult[]
  /** Rendered pages, when it got far enough to make them. */
  pages: string[]
  pdf?: string
}

/**
 * Judges the rendered pages against what was asked for.
 *
 * Supplied by the caller so this package does not depend on `@workspace/
 * subagents` — and so a test can substitute a deterministic judge instead of
 * spending money to prove the plumbing works.
 */
export type AppearanceJudge = (input: {
  /** Workspace paths of the rendered page images. */
  pages: string[]
  /** What the document was supposed to be. */
  request: string
}) => Promise<{ passed: boolean; detail: string }>

export interface VerifyOptions {
  /** What the user asked for. Gate 3 has nothing to judge against without it. */
  request: string
  judge?: AppearanceJudge
  timeoutMs?: number
  maxPages?: number
}

export async function verifyDocument(
  workspace: Workspace,
  path: string,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const gates: GateResult[] = []

  // ---- Gate 1: structure ----
  const structure = await checkStructure(workspace, path)
  gates.push(structure)
  if (!structure.passed) return { ok: false, gates, pages: [] }

  // ---- Gate 2: recalculate ----
  const converted = await toPdf(workspace, path, {
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  gates.push({
    gate: 'recalculate',
    passed: converted.ok,
    detail: converted.ok
      ? 'LibreOffice opened it and wrote a PDF.'
      : (converted.reason ?? 'Conversion failed.'),
  })
  if (!converted.ok) return { ok: false, gates, pages: [] }

  // ---- Gate 3: look at it ----
  const rendered = await toImages(workspace, path, {
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxPages ? { maxPages: options.maxPages } : {}),
  })

  if (!rendered.ok || rendered.pages.length === 0) {
    gates.push({
      gate: 'appearance',
      passed: false,
      detail: rendered.reason ?? 'Could not rasterise the document, so it could not be checked.',
    })
    return { ok: false, gates, pages: [], ...(converted.pdf ? { pdf: converted.pdf } : {}) }
  }

  if (!options.judge) {
    // Not silently passed. A build that skips the gate it depends on most and
    // still reports "ok" is how the gate stops being real.
    gates.push({
      gate: 'appearance',
      passed: false,
      detail:
        'No judge supplied, so the document was rendered but never looked at. ' +
        'Treated as a failure rather than a pass.',
    })
    return { ok: false, gates, pages: rendered.pages, ...(converted.pdf ? { pdf: converted.pdf } : {}) }
  }

  const verdict = await options.judge({ pages: rendered.pages, request: options.request })
  gates.push({ gate: 'appearance', passed: verdict.passed, detail: verdict.detail })

  return {
    ok: gates.every((g) => g.passed),
    gates,
    pages: rendered.pages,
    ...(converted.pdf ? { pdf: converted.pdf } : {}),
  }
}

/**
 * Gate 1, without an XSD validator.
 *
 * The honest version of this gate needs the ECMA-376 schemas and a validating
 * parser, which is a dependency and a licence question of its own. What is here
 * checks the OPC package structure: a valid ZIP, `[Content_Types].xml` present,
 * the root relationship part present, and every XML part actually parsing.
 *
 * That is weaker than schema validation and it is stated plainly rather than
 * described as more than it is. It catches the faults that stop a file opening
 * — a truncated write, a missing content type, malformed XML — which is what
 * gate 1 is for. Schema-valid-but-wrong is gate 2 and gate 3's job anyway.
 */
async function checkStructure(workspace: Workspace, path: string): Promise<GateResult> {
  if (path.toLowerCase().endsWith('.pdf')) {
    const header = await workspace.exec(`head -c 5 "$F"`, { env: { F: `.${path}` }, timeoutMs: 10_000 })
    return {
      gate: 'structure',
      passed: header.stdout.startsWith('%PDF'),
      detail: header.stdout.startsWith('%PDF') ? 'PDF header present.' : 'Not a PDF.',
    }
  }

  const listing = await workspace.exec(`unzip -l "$F" 2>&1`, {
    env: { F: `.${path}` },
    timeoutMs: 30_000,
  })
  if (listing.exitCode !== 0) {
    return {
      gate: 'structure',
      passed: false,
      detail: `Not a readable OOXML package: ${listing.stdout.slice(0, 300)}`,
    }
  }

  const names = listing.stdout
  const missing = ['[Content_Types].xml', '_rels/.rels'].filter((part) => !names.includes(part))
  if (missing.length > 0) {
    return {
      gate: 'structure',
      passed: false,
      detail: `OPC package is missing ${missing.join(' and ')}.`,
    }
  }

  // Every XML part must parse. `xmllint` is the cheapest real check available;
  // where it is absent the gate says so rather than quietly passing.
  const haveXmllint = await workspace.exec('command -v xmllint', { timeoutMs: 10_000 })
  if (haveXmllint.exitCode !== 0) {
    return {
      gate: 'structure',
      passed: true,
      detail: 'OPC package structure is present. xmllint absent, so XML parts were not parsed.',
    }
  }

  const parsed = await workspace.exec(
    `set -e; T=$(mktemp -d); unzip -qq "$F" -d "$T"; ` +
      `find "$T" -name '*.xml' -o -name '*.rels' | while read -r p; do ` +
      `xmllint --noout "$p" || { echo "BAD: $p"; exit 1; }; done; rm -rf "$T"`,
    { env: { F: `.${path}` }, timeoutMs: 60_000 },
  )

  return {
    gate: 'structure',
    passed: parsed.exitCode === 0,
    detail:
      parsed.exitCode === 0
        ? 'OPC package structure valid and every XML part parses.'
        : `Malformed XML inside the package: ${parsed.stdout.slice(0, 300)}`,
  }
}
