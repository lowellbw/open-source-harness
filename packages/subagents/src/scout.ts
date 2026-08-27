import { randomUUID } from 'node:crypto'
import type { ToolSet } from 'ai'
import { Agent, type OrgPolicy } from '@workspace/core'
import { ModelGateway } from '@workspace/gateway-model'
import type { CostBuckets, FilePart, WorkspaceEvent } from '@workspace/protocol'
import { addCost, zeroCost } from '@workspace/protocol'
import type { Workspace } from '@workspace/workspace'
import { readOnly } from './readonly.js'
import { buildScoutFileTools } from './tools.js'

/**
 * Read-only scouts (PLAN-V2 §9).
 *
 * A scout exists to keep something OUT of the parent's context: reading twenty
 * files to answer one question costs the parent twenty files of context
 * forever, and after compaction it has the tokens spent and the answer gone.
 * A scout spends its own context on the reading and hands back a paragraph.
 *
 * Four constraints, each enforced by construction rather than by asking:
 *
 *   - It cannot write. Its workspace refuses (`readonly.ts`).
 *   - It cannot recurse. Its toolset has no spawn tool, so there is nothing to
 *     call. Depth is bounded at one because unbounded fan-out is how a £2
 *     question becomes a £200 one.
 *   - It cannot reach MCP connectors. Containment is only as good as the
 *     narrowest thing it can touch, and a connector is a hole straight out of
 *     the workspace.
 *   - It cannot outspend its allowance. It gets its own gateway with its own
 *     ceiling, so a scout stuck in a loop exhausts its budget and stops rather
 *     than the session's.
 *
 * The report is TEXT, and the caller decides what to do with it. Writing it to
 * a file is the caller's job precisely because the scout cannot write — having
 * it hand back a path it could not have produced would be a lie about where
 * the boundary is.
 */

export interface ScoutOptions {
  /** What to find out. Written as an instruction, not a conversation. */
  task: string
  workspace: Workspace
  policy: OrgPolicy
  /** Cheap by default: scouts read and summarise, which is not premium work. */
  modelAlias?: string
  /** Hard ceiling for this scout alone, in USD. */
  budgetUsd?: number
  maxSteps?: number
  contextMaxTokens?: number
  /**
   * Read-only tools from outside the workspace — web fetch and search.
   *
   * Injected rather than imported so this package does not depend on
   * `packages/session`, which will depend on this one. Anything passed here
   * must be read-only; nothing checks, because the caller is our own code and
   * a runtime check on an arbitrary tool is not possible anyway.
   */
  extraTools?: ToolSet
  /**
   * Images or documents the scout should look at.
   *
   * What makes gate 3 possible: a fresh subagent handed a rendered page and
   * asked whether it matches the request. Read through the read-only workspace,
   * so an attachment is one more thing the scout can see and not touch.
   */
  attachments?: FilePart[]
  /** Parent run, for nesting in the trace. */
  parentRunId: string
  onEvent?: (event: WorkspaceEvent) => void
  /** Injectable for tests; otherwise a fresh gateway with the scout's ceiling. */
  createGateway?: (budgetUsd: number) => ModelGateway
}

export interface ScoutResult {
  subagentId: string
  task: string
  /** What the scout found. Empty when it failed. */
  report: string
  cost: CostBuckets
  stoppedBy: 'complete' | 'budget_exceeded' | 'error'
  error?: string
}

export const DEFAULT_SCOUT_BUDGET_USD = 0.25

export async function spawnScout(options: ScoutOptions): Promise<ScoutResult> {
  const subagentId = randomUUID()
  const budgetUsd = options.budgetUsd ?? DEFAULT_SCOUT_BUDGET_USD

  const emit = (event: WorkspaceEvent) => options.onEvent?.(event)

  emit({
    type: 'subagent.started',
    runId: options.parentRunId,
    ts: Date.now(),
    subagentId,
    task: options.task,
  })

  // A separate gateway, not a separate budget object: BudgetGuard is wired to
  // one Meter, and sharing the parent's would make the scout's ceiling the
  // session's remaining balance rather than its own allowance.
  const gateway =
    options.createGateway?.(budgetUsd) ??
    new ModelGateway({ limits: { perRunUsd: budgetUsd, perSessionUsd: budgetUsd } })

  const scoutWorkspace = readOnly(options.workspace)

  const agent = new Agent({
    gateway,
    // The scout inherits org policy — it is the same org, the same data
    // boundary, the same constraints — with the read-only reality stated as
    // well. Pinning is not what enforces it, but a model that knows it cannot
    // write stops trying and asks for what it actually needs.
    policy: {
      ...options.policy,
      permissions: ['read'],
      constraints: [
        ...options.policy.constraints,
        'You are a read-only research subagent. You cannot write files, run commands, or make changes.',
        'Report what you found and where. Cite workspace paths and line numbers so the answer can be checked.',
        'Be brief. Your entire output is pasted into another agent’s context, so length there is a cost you are spending on its behalf.',
      ],
    },
    modelAlias: options.modelAlias ?? 'Light',
    role: options.policy.role,
    contextMaxTokens: options.contextMaxTokens ?? 40_000,
    maxSteps: options.maxSteps ?? 8,
    readAttachment: (path) => scoutWorkspace.readBytes(path),
    tools: () => ({
      ...buildScoutFileTools({ workspace: scoutWorkspace }),
      ...(options.extraTools ?? {}),
    }),
    // Scout events do not reach the parent's stream. The parent gets one
    // started and one finished event; forwarding every delta would put the
    // scout's whole transcript in the UI, which is the context cost this
    // exists to avoid, moved from the model to the reader.
  })

  const turn = await agent.send(options.task, {
    ...(options.attachments ? { attachments: options.attachments } : {}),
  })
  const cost = gateway.totals().session

  const result: ScoutResult = {
    subagentId,
    task: options.task,
    report: turn.text,
    cost,
    stoppedBy: turn.stoppedBy,
    ...(turn.error ? { error: turn.error.message } : {}),
  }

  emit({
    type: 'subagent.finished',
    runId: options.parentRunId,
    ts: Date.now(),
    subagentId,
    cost,
    stoppedBy: turn.stoppedBy,
    reportChars: turn.text.length,
  })

  return result
}

/** Sums scout spend, for rolling it into the parent's session total. */
export function totalScoutCost(results: ScoutResult[]): CostBuckets {
  return results.reduce((total, result) => addCost(total, result.cost), zeroCost)
}
