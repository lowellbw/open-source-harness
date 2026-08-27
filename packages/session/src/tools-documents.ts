import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { OrgPolicy } from '@workspace/core'
import type { ModelGateway } from '@workspace/gateway-model'
import type { FilePart, WorkspaceEvent } from '@workspace/protocol'
import type { Workspace } from '@workspace/workspace'
import {
  buildDocx,
  buildPptx,
  buildXlsx,
  docxSpecSchema,
  pptxSpecSchema,
  verifyDocument,
  xlsxSpecSchema,
  type AppearanceJudge,
} from '@workspace/documents'
import { spawnScout } from '@workspace/subagents'

/**
 * Making documents, and checking them.
 *
 * The tool does not return until the document has been through all three
 * gates. That is the point: a tool that reports success on "the file was
 * written" teaches the model that writing a file is the job, and the model
 * then tells the user their deck is ready when it is unreadable.
 *
 * Markdown is here too and takes a different path — no OOXML, no LibreOffice,
 * no rasterising. Its gate is that it is written and can be read back. It is
 * the format most things should be, and making it as ceremonious as a .pptx
 * would push the model towards heavier formats for no reason.
 */

export interface DocumentToolOptions {
  workspace: Workspace
  policy: OrgPolicy
  gateway: ModelGateway
  emit: (event: WorkspaceEvent) => void
  /** Cheap tier is fine for looking at a picture and saying what is wrong. */
  judgeModelAlias?: string
  /** Set false to write documents without verifying them. */
  verify?: boolean
}

export function buildDocumentTools(options: DocumentToolOptions): ToolSet {
  const judge = makeSubagentJudge(options)
  const shouldVerify = options.verify !== false

  return {
    writeMarkdown: tool({
      description:
        'Write a Markdown document to the workspace. Prefer this over Word, PowerPoint or ' +
        'Excel unless the user specifically needs an Office file — Markdown renders in the ' +
        'panel beside this conversation, is readable as plain text, and does not need to be ' +
        'converted to be useful.',
      inputSchema: z.object({
        path: z.string().describe('Workspace path ending in .md'),
        title: z.string(),
        /** Markdown body. Headings start at level 2; the title is the level 1. */
        body: z.string().describe('Markdown body. Use ## for sections — the title is the #.'),
      }),
      execute: async ({ path, title, body }) => {
        const target = path.endsWith('.md') ? path : `${path}.md`
        await options.workspace.write(target, `# ${title}\n\n${body.trim()}\n`)
        options.emit({
          type: 'workspace.file.changed',
          runId: 'ui',
          ts: Date.now(),
          path: target,
          op: 'created',
        })

        // Read back rather than trusting the write. Cheap, and it is the only
        // check this format needs.
        const written = await options.workspace.read(target).catch(() => null)
        return written === null
          ? { ok: false, reason: 'Wrote the file but could not read it back.' }
          : { ok: true, path: target, bytes: written.length }
      },
    }),

    createSlideDeck: makeDocumentTool({
      ...options,
      judge,
      shouldVerify,
      name: 'PowerPoint deck',
      extension: 'pptx',
      schema: pptxSpecSchema,
      build: buildPptx,
    }),

    createWordDocument: makeDocumentTool({
      ...options,
      judge,
      shouldVerify,
      name: 'Word document',
      extension: 'docx',
      schema: docxSpecSchema,
      build: buildDocx,
    }),

    createSpreadsheet: makeDocumentTool({
      ...options,
      judge,
      shouldVerify,
      name: 'Excel workbook',
      extension: 'xlsx',
      schema: xlsxSpecSchema,
      build: buildXlsx,
    }),

    documentSpecHelp: tool({
      description:
        'Show a worked example for a document type. The create tools already carry their full ' +
        'schema, so this is only worth calling when an example would be clearer than the ' +
        'field list — a table inside a slide, or formulas referencing other formulas.',
      inputSchema: z.object({ kind: z.enum(['docx', 'pptx', 'xlsx']) }),
      execute: async ({ kind }) => ({ kind, example: SPEC_EXAMPLES[kind] }),
    }),
  }
}

/**
 * One tool per document type, each carrying its real schema.
 *
 * The first version of this was a single `createDocument` with
 * `spec: z.unknown()` and a separate help tool describing the shape. It failed
 * every time, and the way it failed is worth recording: given a parameter with
 * no schema, the model serialised its object and sent a JSON STRING. The
 * second attempt had exactly the right structure — as a string. Ten retries,
 * no file written, the whole step budget gone.
 *
 * A parameter the model cannot see the shape of is a parameter it cannot fill
 * in. The schema belongs in the tool definition, where the provider puts it in
 * front of the model, not in a help tool it has to think to call.
 *
 * The string case is still handled, because a model that has been told the
 * shape can still decide to send it as text, and failing on that would be
 * pedantry at the user's expense.
 */
function makeDocumentTool<T>(config: {
  workspace: Workspace
  emit: (event: WorkspaceEvent) => void
  judge: AppearanceJudge
  shouldVerify: boolean
  name: string
  extension: string
  schema: { parse: (raw: unknown) => T }
  build: (workspace: Workspace, path: string, spec: unknown) => Promise<void>
}) {
  return tool({
    description:
      `Create a ${config.name} and VERIFY it. Before this returns, the file is checked three ` +
      `ways: its package structure, whether an office suite can open and re-save it, and ` +
      `whether a fresh reviewer looking at the rendered pages thinks it matches the request. ` +
      `If a check fails you are told what is wrong — fix it and call this again rather than ` +
      `telling the user it is ready.`,
    inputSchema: z.object({
      path: z.string().describe(`Workspace path ending in .${config.extension}`),
      request: z
        .string()
        .describe(
          'What this document is meant to be, in one or two sentences. The reviewer has not ' +
            'seen this conversation and judges the rendering against this alone.',
        ),
      spec: config.schema as never,
    }),
    execute: async ({ path, request, spec }: { path: string; request: string; spec: unknown }) => {
      const target = path.endsWith(`.${config.extension}`) ? path : `${path}.${config.extension}`

      // Models sometimes send a structured argument as a JSON string. Parsing
      // it costs nothing; refusing costs the user a retry.
      let parsed: unknown = spec
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed)
        } catch {
          return { ok: false, stage: 'build', reason: 'spec was a string but not valid JSON.' }
        }
      }

      try {
        config.schema.parse(parsed)
        await config.build(config.workspace, target, parsed)
      } catch (err) {
        return { ok: false, stage: 'build', reason: describe(err) }
      }

      config.emit({
        type: 'workspace.file.changed',
        runId: 'ui',
        ts: Date.now(),
        path: target,
        op: 'created',
      })

      if (!config.shouldVerify) return { ok: true, path: target, verified: false }

      const verdict = await verifyDocument(config.workspace, target, { request, judge: config.judge })

      return {
        ok: verdict.ok,
        path: target,
        verified: true,
        gates: verdict.gates.map((gate) => ({
          gate: gate.gate,
          passed: gate.passed,
          detail: gate.detail,
        })),
        ...(verdict.ok
          ? {}
          : {
              note: 'Written but not passed. Fix it and create it again; do not tell the user it is ready.',
            }),
      }
    },
  })
}

/**
 * Gate 3: a fresh subagent looks at the rendered pages.
 *
 * Fresh is the load-bearing word. An agent reviewing its own document grades
 * what it MEANT to produce — it knows there were six bullets and reads six. A
 * subagent that has never seen the conversation sees five and a half bullets
 * and says the last one is cut off.
 *
 * It is a scout, so it inherits the containment: it can look at the pages and
 * cannot alter the document it is judging.
 */
export function makeSubagentJudge(options: DocumentToolOptions): AppearanceJudge {
  return async ({ pages, request }) => {
    const attachments: FilePart[] = pages.slice(0, 8).map((page, index) => ({
      type: 'file',
      path: page,
      mediaType: 'image/png',
      filename: `page-${index + 1}.png`,
    }))

    const scout = await spawnScout({
      task:
        `You are reviewing a document you did not write. Attached are its rendered pages.\n\n` +
        `It was supposed to be: ${request}\n\n` +
        `Look at the pages. Report any of these, quoting what you see:\n` +
        `- text running outside its box, overlapping, or cut off at an edge\n` +
        `- text too small to read, or the same colour as its background\n` +
        `- a table with missing or misaligned cells\n` +
        `- an empty region where content was clearly meant to be\n` +
        `- anything that plainly does not match the description above\n\n` +
        `Answer with VERDICT: PASS or VERDICT: FAIL on the first line, then one or two ` +
        `sentences. Judge only what is visible. Do not fail it for being plain.`,
      workspace: options.workspace,
      policy: options.policy,
      parentRunId: 'ui',
      attachments,
      modelAlias: options.judgeModelAlias ?? 'Light',
      maxSteps: 2,
      onEvent: options.emit,
    })

    // The reviewer costs money. Rolled into the session total the user is
    // watching, or a document that took seven verification passes looks free.
    options.gateway.meter.record(scout.cost)
    const totals = options.gateway.totals()
    options.emit({
      type: 'cost.updated',
      runId: 'ui',
      ts: Date.now(),
      run: totals.run,
      session: totals.session,
      delta: scout.cost,
      model: options.judgeModelAlias ?? 'Light',
    })

    if (scout.stoppedBy !== 'complete') {
      // An unavailable reviewer is not a pass. The gate that cannot run is the
      // gate that reports a failure, or it stops being a gate.
      return {
        passed: false,
        detail: `The reviewer could not run (${scout.error ?? scout.stoppedBy}), so the rendering was never checked.`,
      }
    }

    const text = scout.report.trim()
    const passed = /VERDICT:\s*PASS/i.test(text)
    return {
      passed,
      detail: text.slice(0, 600) || 'The reviewer returned nothing.',
    }
  }
}

function describe(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues: { path: (string | number)[]; message: string }[] }).issues
    return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Worked examples of each specification.
 *
 * Exported so the tests can parse them through the real schemas. If a builder's
 * shape changes and these are not updated, that test fails — which is the
 * mechanism that stops the help drifting away from the truth.
 */
export const SPEC_EXAMPLES = {
  docx: {
    title: 'Quarterly Review',
    subtitle: 'Q3 2026',
    blocks: [
      { type: 'heading', level: 1, text: 'Findings' },
      {
        type: 'paragraph',
        runs: [{ text: 'Uptake was ' }, { text: 'ahead of plan', bold: true }, { text: '.' }],
      },
      { type: 'bullets', items: ['Adoption up 14%', 'Churn flat'] },
      { type: 'numbered', items: ['Agree the budget', 'Brief the team'] },
      {
        type: 'table',
        rows: [
          ['Region', 'Users'],
          ['EMEA', '4,100'],
        ],
      },
      { type: 'pageBreak' },
    ],
  },
  pptx: {
    title: 'The Agentic Workspace',
    subtitle: 'Plan v2',
    // No `coverSlide` here on purpose. The example is what the model copies,
    // so an example that opts into a cover produces a cover every time —
    // including when the user asked for exactly three slides and got four.
    slides: [
      {
        title: 'Why now',
        bullets: ['Parity with Cowork', 'Choice of model', 'Runs on your machine'],
        notes: 'Keep this to ninety seconds.',
      },
      {
        title: 'Numbers',
        bullets: ['Two lines at most beside a table'],
        table: {
          rows: [
            ['Tier', 'Seats'],
            ['Pilot', '40'],
          ],
        },
      },
      { title: 'A picture', bullets: ['Six bullets maximum'], image: '/images/diagram.png' },
    ],
  },
  xlsx: {
    sheets: [
      {
        name: 'Costs',
        rows: [
          ['Item', 'Qty', 'Unit', 'Total'],
          ['Seats', 40, 25, null],
          ['Support', 1, 900, null],
        ],
        formulas: { D2: 'B2*C2', D3: 'B3*C3', D4: 'SUM(D2:D3)' },
      },
    ],
  },
} as const

export const SPEC_SCHEMAS = {
  docx: docxSpecSchema,
  pptx: pptxSpecSchema,
  xlsx: xlsxSpecSchema,
}
