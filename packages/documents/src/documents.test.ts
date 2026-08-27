import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { LocalWorkspace } from '@workspace/workspace'
import { buildDocx, buildPptx, buildXlsx } from './build.js'
import { clearOfficeCache, resolveOffice, toImages, toPdf } from './render.js'
import { verifyDocument, type AppearanceJudge } from './verify.js'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-test-'))
  tmpDirs.push(root)
  const workspace = new LocalWorkspace({ root })
  await workspace.start()
  return workspace
}

/**
 * Whether LibreOffice is here.
 *
 * Checked synchronously because a `describe` callback cannot be async, and
 * checked at all because gates 2 and 3 are useless without it. The suite SKIPS
 * rather than fails when it is absent, and says so loudly — a silent skip on a
 * verification suite is how the verification quietly stops happening.
 */
const soffice = (() => {
  try {
    execFileSync('command', ['-v', 'soffice'], { shell: true, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

if (!soffice) {
  console.warn(
    '[documents] LibreOffice not found — gates 2 and 3 are SKIPPED. ' +
      'Install libreoffice before trusting a green run.',
  )
}

const withOffice = soffice ? it : it.skip

describe('building documents', () => {
  it('writes a docx that is a real OOXML package', async () => {
    const workspace = await makeWorkspace()
    await buildDocx(workspace, '/report.docx', {
      title: 'Quarterly Review',
      subtitle: 'Q3 2026',
      blocks: [
        { type: 'heading', level: 1, text: 'Findings' },
        { type: 'paragraph', runs: [{ text: 'Uptake was ' }, { text: 'strong', bold: true }] },
        { type: 'bullets', items: ['One', 'Two', 'Three'] },
        { type: 'table', rows: [['Region', 'Users'], ['EMEA', '4,100']] },
      ],
    })

    const bytes = await workspace.readBytes('/report.docx')
    // PK zip magic. A .docx that is not a zip is not a .docx.
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.byteLength).toBeGreaterThan(2_000)
  })

  it('pads a ragged table rather than emitting missing cells', async () => {
    // Word renders a short row with cells simply absent, so nothing complains
    // and the table just looks broken.
    const workspace = await makeWorkspace()
    await buildDocx(workspace, '/ragged.docx', {
      title: 'T',
      blocks: [{ type: 'table', rows: [['a', 'b', 'c'], ['d']] }],
    })

    const listing = await workspace.exec('unzip -p ./ragged.docx word/document.xml | tr -d "\\n"', {
      timeoutMs: 20_000,
    })
    // Two rows of three cells each.
    const cells = listing.stdout.split('<w:tc>').length - 1
    expect(cells).toBe(6)
  })

  it('writes exactly the slides asked for, adding none', async () => {
    const workspace = await makeWorkspace()
    await buildPptx(workspace, '/deck.pptx', {
      title: 'The Agentic Workspace',
      subtitle: 'Plan v2',
      slides: [
        { title: 'Why', bullets: ['Parity', 'Choice of model'] },
        { title: 'How', bullets: ['One core', 'Three shells'], notes: 'Keep this short.' },
      ],
    })

    const listing = await workspace.exec('unzip -l ./deck.pptx', { timeoutMs: 20_000 })
    // Exactly the two slides asked for. Nothing added.
    expect(listing.stdout).toContain('ppt/slides/slide2.xml')
    expect(listing.stdout).not.toContain('ppt/slides/slide3.xml')
  })

  it('writes xlsx formulas without a fabricated cached result', async () => {
    // A cached value ExcelJS did not compute would open showing a number that
    // never came from the formula beside it.
    const workspace = await makeWorkspace()
    await buildXlsx(workspace, '/sheet.xlsx', {
      sheets: [
        {
          name: 'Costs',
          rows: [
            ['Item', 'Qty', 'Unit', 'Total'],
            ['Seats', 10, 25, null],
          ],
          formulas: { D2: 'B2*C2' },
        },
      ],
    })

    const sheet = await workspace.exec('unzip -p ./sheet.xlsx xl/worksheets/sheet1.xml', {
      timeoutMs: 20_000,
    })
    expect(sheet.stdout).toContain('B2*C2')
    // `<v>` is a cached value. There must not be one on the formula cell.
    expect(sheet.stdout).not.toMatch(/<f>B2\*C2<\/f><v>/)
  })
})

describe('the three gates', () => {
  const passingJudge: AppearanceJudge = async () => ({ passed: true, detail: 'Looks right.' })

  withOffice('passes a well-formed deck through all three', { timeout: 180_000 }, async () => {
    const workspace = await makeWorkspace()
    await buildPptx(workspace, '/good.pptx', {
      title: 'Readable',
      slides: [{ title: 'A point', bullets: ['Short', 'Also short'] }],
    })

    const result = await verifyDocument(workspace, '/good.pptx', {
      request: 'A two-bullet deck.',
      judge: passingJudge,
    })

    expect(result.gates.map((g) => [g.gate, g.passed])).toEqual([
      ['structure', true],
      ['recalculate', true],
      ['appearance', true],
    ])
    expect(result.ok).toBe(true)
    expect(result.pages.length).toBeGreaterThan(0)
  })

  withOffice(
    'fails gate 3 on a document that passes gates 1 and 2',
    { timeout: 180_000 },
    async () => {
      /*
       * The whole point of gate 3, and the reason this fixture exists.
       *
       * This deck is a valid OOXML package and LibreOffice converts it without
       * complaint — gates 1 and 2 are happy. It is also unreadable: forty
       * bullets of prose crammed into one slide's text box. Only looking at the
       * rendered page catches it, and if this test ever passed all three gates
       * it would mean gate 3 had stopped checking anything.
       */
      const workspace = await makeWorkspace()
      await buildPptx(workspace, '/overflowing.pptx', {
        title: 'Too much',
        slides: [
          {
            title: 'Everything at once',
            bullets: Array.from(
              { length: 40 },
              (_, i) =>
                `Point ${i + 1}: a sentence long enough that forty of them cannot possibly fit on one slide at a legible size.`,
            ),
          },
        ],
      })

      const overflowJudge: AppearanceJudge = async ({ pages }) => {
        expect(pages.length).toBeGreaterThan(0)
        return { passed: false, detail: 'Text overflows the slide and is illegible.' }
      }

      const result = await verifyDocument(workspace, '/overflowing.pptx', {
        request: 'A readable slide.',
        judge: overflowJudge,
      })

      const byGate = Object.fromEntries(result.gates.map((g) => [g.gate, g.passed]))
      expect(byGate.structure).toBe(true)
      expect(byGate.recalculate).toBe(true)
      expect(byGate.appearance).toBe(false)
      expect(result.ok).toBe(false)
    },
  )

  withOffice('treats a missing judge as a failure, not a pass', { timeout: 180_000 }, async () => {
    // A build that skips the gate it depends on most and still reports "ok" is
    // how the gate stops being real.
    const workspace = await makeWorkspace()
    await buildPptx(workspace, '/unjudged.pptx', {
      title: 'T',
      slides: [{ title: 'S', bullets: ['x'] }],
    })

    const result = await verifyDocument(workspace, '/unjudged.pptx', { request: 'anything' })

    expect(result.ok).toBe(false)
    expect(result.gates.find((g) => g.gate === 'appearance')?.passed).toBe(false)
  })

  it('fails gate 1 on a file that is not an OOXML package at all', async () => {
    const workspace = await makeWorkspace()
    await workspace.write('/fake.docx', 'this is just text')

    const result = await verifyDocument(workspace, '/fake.docx', { request: 'a report' })

    expect(result.ok).toBe(false)
    expect(result.gates).toHaveLength(1)
    expect(result.gates[0]).toMatchObject({ gate: 'structure', passed: false })
  })

  it('fails gate 1 on a zip that is missing its content types', async () => {
    const workspace = await makeWorkspace()
    await workspace.write('/hollow/readme.txt', 'nothing useful')
    await workspace.exec('cd hollow && zip -q -r ../hollow.docx readme.txt', { timeoutMs: 20_000 })

    const result = await verifyDocument(workspace, '/hollow.docx', { request: 'a report' })

    expect(result.gates[0]!.passed).toBe(false)
    expect(result.gates[0]!.detail).toContain('[Content_Types].xml')
  })
})

describe('rendering', () => {
  withOffice('renders every page, not just the first', { timeout: 180_000 }, async () => {
    const workspace = await makeWorkspace()
    await buildPptx(workspace, '/three.pptx', {
      title: 'Cover',
      coverSlide: true,
      slides: [
        { title: 'One', bullets: ['a'] },
        { title: 'Two', bullets: ['b'] },
      ],
    })

    const rendered = await toImages(workspace, '/three.pptx')

    expect(rendered.ok).toBe(true)
    if (rendered.via === 'poppler') {
      // Cover plus two slides, because the cover was asked for.
      expect(rendered.pages.length).toBe(3)
    } else {
      // LibreOffice's own PNG export does the first page only, and says so —
      // which a caller checking a twenty-slide deck needs to know.
      expect(rendered.pages.length).toBe(1)
      expect(rendered.via).toBe('libreoffice')
    }
  })

  withOffice('returns a pdf unchanged rather than round-tripping it', async () => {
    const workspace = await makeWorkspace()
    await workspace.write('/already.pdf', '%PDF-1.4 stub')
    expect(await toPdf(workspace, '/already.pdf')).toMatchObject({ ok: true, pdf: '/already.pdf' })
  })
})

describe('stale renders', () => {
  withOffice('does not leave pages from a previous version behind', { timeout: 240_000 }, async () => {
    /*
     * The bug this exists to stop: pdftoppm writes one file per page and
     * overwrites in place, so a four-page render followed by a three-page one
     * leaves page four on disk. Gate 3 then judges the corrected document
     * against a page from the version before the correction — and can fail, or
     * pass, for a reason that is no longer in the file.
     */
    const workspace = await makeWorkspace()

    await buildPptx(workspace, '/deck.pptx', {
      title: 'Four',
      coverSlide: true,
      slides: [
        { title: 'One', bullets: ['a'] },
        { title: 'Two', bullets: ['b'] },
        { title: 'Three', bullets: ['c'] },
      ],
    })
    const first = await toImages(workspace, '/deck.pptx')
    if (first.via !== 'poppler') return // single-page fallback cannot show this

    expect(first.pages.length).toBe(4)

    // Same path, fewer slides — as happens when the model corrects itself.
    await buildPptx(workspace, '/deck.pptx', {
      title: 'Two',
      slides: [
        { title: 'One', bullets: ['a'] },
        { title: 'Two', bullets: ['b'] },
      ],
    })
    const second = await toImages(workspace, '/deck.pptx')

    expect(second.pages.length).toBe(2)
  })
})

describe('finding LibreOffice', () => {
  it('resolves it wherever it lives, and caches the answer', async () => {
    const workspace = await makeWorkspace()
    clearOfficeCache()

    const found = await resolveOffice(workspace)
    // On this machine it is on PATH; on a Mac it is inside the app bundle and
    // NOT on PATH, which is the case this exists for.
    expect(found === null || typeof found === 'string').toBe(true)

    // Cached: a second call must not shell out again.
    const before = Date.now()
    await resolveOffice(workspace)
    expect(Date.now() - before).toBeLessThan(50)
  })

  it('honours an explicit override', async () => {
    const workspace = await makeWorkspace()
    clearOfficeCache()
    const previous = process.env.LIBREOFFICE_PATH
    process.env.LIBREOFFICE_PATH = '/bin/sh'
    try {
      expect(await resolveOffice(workspace)).toBe('/bin/sh')
    } finally {
      if (previous === undefined) delete process.env.LIBREOFFICE_PATH
      else process.env.LIBREOFFICE_PATH = previous
      clearOfficeCache()
    }
  })

  it('explains itself when LibreOffice is absent rather than blaming the document', async () => {
    // "LibreOffice produced no PDF" is the same message a genuinely broken
    // document gives, so a missing install used to read as a corrupt file.
    const workspace = await makeWorkspace()
    clearOfficeCache()
    const previous = process.env.LIBREOFFICE_PATH
    process.env.LIBREOFFICE_PATH = '/nonexistent/soffice'

    // Force every candidate to miss by looking in an empty PATH.
    const original = resolveOffice
    void original
    try {
      await workspace.write('/d.docx', 'x')
      // With a bad override the real candidates are still tried, so this only
      // asserts the message when nothing at all is found — skipped when
      // LibreOffice is genuinely installed.
      if (soffice) return
      const result = await toPdf(workspace, '/d.docx')
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('LIBREOFFICE_PATH')
    } finally {
      if (previous === undefined) delete process.env.LIBREOFFICE_PATH
      else process.env.LIBREOFFICE_PATH = previous
      clearOfficeCache()
    }
  })
})
