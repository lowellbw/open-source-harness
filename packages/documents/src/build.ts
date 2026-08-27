import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJSImport from 'pptxgenjs'
import type { Workspace } from '@workspace/workspace'
import { z } from 'zod'

/**
 * Producing documents.
 *
 * Clean-room from ECMA-376 over three MIT libraries. NOTHING here is derived
 * from Anthropic's document skills — that licence forbids derivative works,
 * distribution and sublicensing, and this is a product we ship. It is an
 * invariant in CLAUDE.md, not a preference.
 *
 * The specs below are deliberately small. A model given a full OOXML surface
 * produces documents that are technically valid and visually incoherent; a
 * model given "title, bullets, optional table" produces something that looks
 * like a person made it. Restricting the vocabulary is a quality decision, not
 * a scoping compromise — and the three verification gates exist because it is
 * not sufficient on its own.
 */

// ---------------------------------------------------------------- shared

const inlineSchema = z.object({
  text: z.string(),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
})

const tableSchema = z.object({
  /** First row is the header. Every row must have the same length. */
  rows: z.array(z.array(z.string())).min(1),
})

// ---------------------------------------------------------------- docx

export const docxBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(3), text: z.string() }),
  z.object({ type: z.literal('paragraph'), runs: z.array(inlineSchema).min(1) }),
  z.object({ type: z.literal('bullets'), items: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('numbered'), items: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('table'), ...tableSchema.shape }),
  z.object({ type: z.literal('pageBreak') }),
])

export const docxSpecSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  blocks: z.array(docxBlockSchema).min(1),
})

export type DocxSpec = z.infer<typeof docxSpecSchema>

export async function buildDocx(workspace: Workspace, path: string, raw: unknown): Promise<void> {
  const spec = docxSpecSchema.parse(raw)

  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE }),
    ...(spec.subtitle
      ? [new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true })] })]
      : []),
  ]

  for (const block of spec.blocks) {
    switch (block.type) {
      case 'heading':
        children.push(
          new Paragraph({
            text: block.text,
            heading:
              block.level === 1
                ? HeadingLevel.HEADING_1
                : block.level === 2
                  ? HeadingLevel.HEADING_2
                  : HeadingLevel.HEADING_3,
          }),
        )
        break

      case 'paragraph':
        children.push(
          new Paragraph({
            children: block.runs.map(
              (run) => new TextRun({ text: run.text, bold: run.bold, italics: run.italic }),
            ),
          }),
        )
        break

      case 'bullets':
        for (const item of block.items) {
          children.push(new Paragraph({ text: item, bullet: { level: 0 } }))
        }
        break

      case 'numbered':
        for (const item of block.items) {
          children.push(new Paragraph({ text: item, numbering: { reference: 'ordered', level: 0 } }))
        }
        break

      case 'table':
        children.push(buildDocxTable(block.rows))
        break

      case 'pageBreak':
        children.push(new Paragraph({ pageBreakBefore: true }))
        break
    }
  }

  const document = new Document({
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'start' }],
        },
      ],
    },
    sections: [{ children }],
  })

  await workspace.write(path, new Uint8Array(await Packer.toBuffer(document)))
}

function buildDocxTable(rows: string[][]): Table {
  const width = Math.max(...rows.map((r) => r.length))
  return new Table({
    // Ragged rows are the most common way a generated table comes out broken:
    // Word renders the short row with missing cells rather than refusing, so
    // nothing complains and the table simply looks wrong.
    rows: rows.map(
      (row, index) =>
        new TableRow({
          children: Array.from({ length: width }, (_, column) => {
            const text = row[column] ?? ''
            return new TableCell({
              children: [
                new Paragraph({ children: [new TextRun({ text, bold: index === 0 })] }),
              ],
            })
          }),
        }),
    ),
  })
}

// ---------------------------------------------------------------- pptx

/**
 * The slice of pptxgenjs this file uses.
 *
 * The package pairs `export default` with `export as namespace`, so under
 * NodeNext the imported binding resolves to a namespace and cannot be used in
 * type position — `new PptxGenJS()` does not typecheck even though, at runtime,
 * the default export IS the constructor (verified, not assumed).
 *
 * Declaring the surface used rather than casting to `any` keeps the call sites
 * checked. The option bags stay loose because their real types live inside that
 * unreachable namespace; the three verification gates are what actually catch a
 * wrong option, and they check the rendered document rather than the call.
 */
interface PptxSlide {
  addText(text: string | object[], options?: Record<string, unknown>): unknown
  addTable(rows: object[][], options?: Record<string, unknown>): unknown
  addImage(options: Record<string, unknown>): unknown
  addNotes(notes: string): unknown
}

interface PptxDeck {
  layout: string
  addSlide(): PptxSlide
  write(options: { outputType: 'nodebuffer' }): Promise<unknown>
}

const Deck = PptxGenJSImport as unknown as new () => PptxDeck

export const slideSchema = z.object({
  title: z.string(),
  /** Keep to six or fewer. A slide is not a document. */
  bullets: z.array(z.string()).default([]),
  notes: z.string().optional(),
  /** Workspace path to an image to place on the slide. */
  image: z.string().optional(),
  table: tableSchema.optional(),
})

export const pptxSpecSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  slides: z.array(slideSchema).min(1),
})

export type PptxSpec = z.infer<typeof pptxSpecSchema>

export async function buildPptx(workspace: Workspace, path: string, raw: unknown): Promise<void> {
  const spec = pptxSpecSchema.parse(raw)

  const deck = new Deck()
  deck.layout = 'LAYOUT_16x9'

  const cover = deck.addSlide()
  cover.addText(spec.title, { x: 0.6, y: 2.1, w: 8.8, h: 1.0, fontSize: 36, bold: true })
  if (spec.subtitle) {
    cover.addText(spec.subtitle, { x: 0.6, y: 3.1, w: 8.8, h: 0.6, fontSize: 18, color: '666666' })
  }

  for (const entry of spec.slides) {
    const slide = deck.addSlide()
    slide.addText(entry.title, { x: 0.6, y: 0.4, w: 8.8, h: 0.8, fontSize: 26, bold: true })

    const hasSide = Boolean(entry.image)
    const bodyWidth = hasSide ? 4.6 : 8.8

    if (entry.bullets.length > 0) {
      slide.addText(
        entry.bullets.map((text) => ({ text, options: { bullet: true } })),
        // `shrinkText` is the difference between a slide with six bullets and a
        // slide whose sixth bullet is off the bottom edge. Gate 3 exists to
        // catch what this misses, but it should not have to catch this.
        { x: 0.6, y: 1.4, w: bodyWidth, h: 3.6, fontSize: 16, shrinkText: true, valign: 'top' },
      )
    }

    if (entry.table) {
      const width = Math.max(...entry.table.rows.map((r) => r.length))
      slide.addTable(
        entry.table.rows.map((row, index) =>
          Array.from({ length: width }, (_, column) => ({
            text: row[column] ?? '',
            options: { bold: index === 0, fontSize: 12 },
          })),
        ),
        { x: 0.6, y: entry.bullets.length > 0 ? 3.4 : 1.4, w: bodyWidth, border: { pt: 0.5, color: 'DDDDDD' } },
      )
    }

    if (entry.image) {
      try {
        const bytes = await workspace.readBytes(entry.image)
        slide.addImage({
          data: `image/png;base64,${Buffer.from(bytes).toString('base64')}`,
          x: 5.4,
          y: 1.4,
          w: 4.0,
          h: 3.4,
          sizing: { type: 'contain', w: 4.0, h: 3.4 },
        })
      } catch {
        // A missing image must not lose the whole deck. The slide renders
        // without it and gate 3 will notice the gap.
      }
    }

    if (entry.notes) slide.addNotes(entry.notes)
  }

  const buffer = (await deck.write({ outputType: 'nodebuffer' })) as Buffer
  await workspace.write(path, new Uint8Array(buffer))
}

// ---------------------------------------------------------------- xlsx

export const sheetSchema = z.object({
  name: z.string().max(31),
  /** First row is the header. */
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1),
  /**
   * Formulas by cell reference, e.g. `{ "D2": "SUM(B2:C2)" }`. Written without
   * a leading `=`; gate 2 is what proves they actually evaluate.
   */
  formulas: z.record(z.string(), z.string()).default({}),
  /** Column widths in characters. Auto-fitted from content when absent. */
  widths: z.array(z.number()).optional(),
})

export const xlsxSpecSchema = z.object({
  sheets: z.array(sheetSchema).min(1),
})

export type XlsxSpec = z.infer<typeof xlsxSpecSchema>

export async function buildXlsx(workspace: Workspace, path: string, raw: unknown): Promise<void> {
  const spec = xlsxSpecSchema.parse(raw)
  const book = new ExcelJS.Workbook()

  for (const sheet of spec.sheets) {
    const worksheet = book.addWorksheet(sheet.name)

    sheet.rows.forEach((row, index) => {
      const added = worksheet.addRow(row.map((cell) => cell ?? ''))
      if (index === 0) added.font = { bold: true }
    })

    for (const [reference, formula] of Object.entries(sheet.formulas)) {
      // No `result` supplied on purpose. ExcelJS will not compute one, and a
      // fabricated cached value is worse than none: the spreadsheet opens
      // showing a number that never came from the formula beside it.
      worksheet.getCell(reference).value = { formula: formula.replace(/^=/, '') }
    }

    const widths = sheet.widths ?? autoWidths(sheet.rows)
    widths.forEach((width, index) => {
      worksheet.getColumn(index + 1).width = width
    })
  }

  const buffer = await book.xlsx.writeBuffer()
  await workspace.write(path, new Uint8Array(buffer))
}

/** Wide enough to read, capped so one long cell does not set the whole column. */
function autoWidths(rows: (string | number | null)[][]): number[] {
  const width = Math.max(...rows.map((r) => r.length))
  return Array.from({ length: width }, (_, column) => {
    const longest = rows.reduce((max, row) => {
      const value = row[column]
      return Math.max(max, value === null || value === undefined ? 0 : String(value).length)
    }, 0)
    return Math.min(Math.max(longest + 2, 8), 60)
  })
}
