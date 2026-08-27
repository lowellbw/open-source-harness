import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { OrgPolicy } from '@workspace/core'
import type { ModelGateway } from '@workspace/gateway-model'
import type { WorkspaceEvent } from '@workspace/protocol'
import type { Workspace } from '@workspace/workspace'
import { spawnScout, DEFAULT_SCOUT_BUDGET_USD, type ScoutResult } from './scout.js'

/**
 * The tool the parent calls to send scouts out.
 *
 * Takes a LIST of tasks rather than one, because the win is concurrency: three
 * scouts reading three parts of a codebase at once take as long as the slowest,
 * and the parent's context grows by three paragraphs instead of thirty files.
 * A one-task-per-call tool gets used serially, which throws that away.
 *
 * Reports come back as file paths, not pasted text. A scout that hands back
 * 40KB of findings has moved the context problem rather than solved it: the
 * parent reads the path if it needs the detail, and a one-line summary
 * otherwise. The parent writes the file, because the scout cannot.
 */

export interface SubagentToolOptions {
  workspace: Workspace
  policy: OrgPolicy
  /** For rolling scout spend into the session total the user sees. */
  gateway: ModelGateway
  emit: (event: WorkspaceEvent) => void
  /** Read-only tools from outside the workspace — web fetch, web search. */
  extraTools?: ToolSet
  modelAlias?: string
  budgetUsdPerScout?: number
  /** Concurrency cap. Ten scouts at once is a bill, not a strategy. */
  maxConcurrent?: number
}

export function buildSubagentTools(options: SubagentToolOptions): ToolSet {
  const maxConcurrent = options.maxConcurrent ?? 4
  const budgetUsd = options.budgetUsdPerScout ?? DEFAULT_SCOUT_BUDGET_USD

  return {
    research: tool({
      description:
        'Send read-only research subagents to investigate questions in parallel, without ' +
        'filling this conversation with everything they read. Each gets its own context and ' +
        'budget, and returns a short report written to a file. Use this when answering would ' +
        'mean reading many files, or when several independent questions can be chased at ' +
        'once. Subagents CANNOT edit files, run commands, or use connectors — do the work ' +
        'yourself once they report back.',
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              task: z
                .string()
                .describe(
                  'A complete, self-contained instruction. The subagent sees none of this ' +
                    'conversation, so include everything it needs to know.',
                ),
              label: z.string().describe('Two or three words, for the trace'),
            }),
          )
          .min(1)
          .max(maxConcurrent)
          .describe('Independent questions. They run concurrently, so do not make them depend on each other.'),
      }),
      execute: async ({ tasks }) => {
        const results = await Promise.all(
          tasks.map((entry) =>
            spawnScout({
              task: entry.task,
              workspace: options.workspace,
              policy: options.policy,
              parentRunId: 'ui',
              budgetUsd,
              onEvent: options.emit,
              ...(options.modelAlias ? { modelAlias: options.modelAlias } : {}),
              ...(options.extraTools ? { extraTools: options.extraTools } : {}),
            })
              // A scout that throws must not take the other scouts with it —
              // Promise.all rejects on the first failure and discards the rest,
              // including work already paid for.
              .catch(
                (err): ScoutResult => ({
                  subagentId: 'failed',
                  task: entry.task,
                  report: '',
                  cost: { ...zeroBuckets },
                  stoppedBy: 'error',
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
              .then((result) => ({ result, label: entry.label })),
          ),
        )

        const reports = await Promise.all(
          results.map(async ({ result, label }) => {
            if (result.stoppedBy !== 'complete' || !result.report) {
              return {
                label,
                ok: false,
                reason: result.error ?? `Stopped: ${result.stoppedBy}`,
                costUsd: round(result.cost.usd),
              }
            }

            // Written by the parent, since the scout has no write access. The
            // path is what goes in context; the body is there when wanted.
            const path = `/.research/${slug(label)}-${result.subagentId.slice(0, 8)}.md`
            await options.workspace.write(
              path,
              `# ${label}\n\n**Task:** ${result.task}\n\n---\n\n${result.report}\n`,
            )

            return {
              label,
              ok: true,
              path,
              costUsd: round(result.cost.usd),
              // Enough to decide whether to open the file, not enough to be a
              // second copy of it.
              summary: firstParagraph(result.report),
            }
          }),
        )

        // Scout spend is the same org's money on the same key, so it belongs in
        // the session total the user is watching — even though each scout was
        // separately capped.
        for (const { result } of results) options.gateway.meter.record(result.cost)
        const totals = options.gateway.totals()
        options.emit({
          type: 'cost.updated',
          runId: 'ui',
          ts: Date.now(),
          run: totals.run,
          session: totals.session,
          delta: sum(results.map((r) => r.result.cost.usd)),
          model: options.modelAlias ?? 'Light',
        })

        return { reports, count: reports.length }
      },
    }),
  }
}

const zeroBuckets = {
  uncachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  webSearches: 0,
  usd: 0,
}

function sum(values: number[]) {
  return { ...zeroBuckets, usd: values.reduce((a, b) => a + b, 0) }
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'report'
  )
}

/** The opening paragraph, capped. Enough to decide whether to open the file. */
function firstParagraph(report: string): string {
  const paragraph = report.trim().split(/\n\s*\n/)[0] ?? ''
  return paragraph.length > 400 ? `${paragraph.slice(0, 400)}…` : paragraph
}
