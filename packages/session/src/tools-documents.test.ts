import { describe, expect, it } from 'vitest'
import { SPEC_EXAMPLES, SPEC_SCHEMAS } from './tools-documents.js'

/**
 * The help must not lie.
 *
 * `documentSpecHelp` hands the model a worked example, because a model copies
 * the shape of an example far more reliably than it infers one from a schema.
 * The cost of that choice is that the example can drift away from what
 * `createDocument` actually accepts, and a model following stale help gets a
 * validation error it cannot diagnose.
 *
 * So the examples are parsed through the real schemas. Change a builder without
 * updating its example and this fails, which is the whole point.
 */
describe('spec examples', () => {
  it.each(['docx', 'pptx', 'xlsx'] as const)('%s example parses through its own schema', (kind) => {
    const result = SPEC_SCHEMAS[kind].safeParse(SPEC_EXAMPLES[kind])
    if (!result.success) {
      throw new Error(
        `${kind} example does not match its schema:\n` +
          result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
      )
    }
    expect(result.success).toBe(true)
  })

  it('shows every block type docx supports', () => {
    // An example that omits a block type is an example that quietly makes it
    // unreachable — the model never learns the type exists.
    const shown = new Set(SPEC_EXAMPLES.docx.blocks.map((b) => b.type))
    expect([...shown].sort()).toEqual([
      'bullets',
      'heading',
      'numbered',
      'pageBreak',
      'paragraph',
      'table',
    ])
  })

  it('shows a pptx slide with a table and one with an image', () => {
    expect(SPEC_EXAMPLES.pptx.slides.some((s) => 'table' in s)).toBe(true)
    expect(SPEC_EXAMPLES.pptx.slides.some((s) => 'image' in s)).toBe(true)
  })

  it('shows an xlsx formula that references another formula', () => {
    // SUM over a column of computed cells is the case that breaks when a
    // builder writes fabricated cached values.
    expect(Object.values(SPEC_EXAMPLES.xlsx.sheets[0]!.formulas)).toContain('SUM(D2:D3)')
  })
})
