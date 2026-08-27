import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { WorkspaceEvent } from '@workspace/protocol'
import type { Workspace } from '@workspace/workspace'
import type { ApprovalGate } from './approvals.js'

/**
 * Running Python, for data analysis.
 *
 * `runCommand` can already run `python3 -c`, so this is not about capability.
 * It is about three things that make the difference between a shell that
 * happens to have Python on it and something you can analyse data with.
 *
 * STATE LIVES IN THE WORKSPACE, NOT IN A KERNEL. Each call is a fresh process.
 * A persistent kernel would let you load a large frame once, which is the
 * obvious win — and it brings process lifecycle, state that goes stale against
 * files that changed underneath it, and a whole class of "it worked in the
 * last cell" confusion. Files are a boring, inspectable, restartable form of
 * state, and the tool's description says to use them.
 *
 * FIGURES ARE FOUND, NOT DESCRIBED. matplotlib writes to a file; the tool
 * notices which files appeared and reports them, so a chart lands in the
 * artifact pane instead of being described in prose.
 *
 * PATHS ARE RELATIVE, AND THAT IS NOT A DETAIL. A shell — and so a Python
 * process — gets a real filesystem with a real `/`, unlike the file tools,
 * which rewrite a leading `/` to the workspace root. It is the asymmetry
 * CLAUDE.md calls deliberate, and the failure mode here is quiet: a model that
 * writes `plt.savefig("/chart.png")` believes it saved into the workspace, and
 * has actually written to the root of the machine, where nothing will find it.
 * So the description says so, twice, in the words a model reading it will act
 * on.
 *
 * IT IS GATED ONCE, NOT EVERY TIME. Arbitrary code cannot be judged reversible
 * in advance, so §9 says gate it — but prompting on every cell of an analysis
 * is precisely the pattern §9 warns about. So the prompt offers consent for the
 * session, and the user answers a question they understand ("may this run
 * Python?") once rather than a question they stop reading four times.
 */

export interface PythonToolOptions {
  workspace: Workspace
  approvals: ApprovalGate
  emit: (event: WorkspaceEvent) => void
  timeoutMs?: number
  maxOutputChars?: number
  /** Where scripts and figures go. Under the workspace, so they are visible. */
  directory?: string
}

export const PYTHON_SCOPE = 'python'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.webp']

export function buildPythonTools(options: PythonToolOptions): ToolSet {
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxOutput = options.maxOutputChars ?? 20_000
  const directory = options.directory ?? '/.python'

  return {
    runPython: tool({
      description:
        'Run Python in the workspace, for data analysis, calculation and charting. pandas, ' +
        'numpy, matplotlib, openpyxl and tabulate are available. Print what you want to see — ' +
        'stdout comes back to you.\n\n' +
        'USE RELATIVE PATHS. The working directory is the workspace root, so open("data.csv") ' +
        'and plt.savefig("charts/sales.png") both land in the workspace. A path starting with ' +
        '"/" is the real filesystem root of the machine, NOT the workspace — writing there ' +
        'succeeds and the file is then somewhere nobody will look for it.\n\n' +
        'Each call is a FRESH process with no memory of the last one. Save anything you want to ' +
        'reuse to a file and read it back in the next call.\n\n' +
        'Files you create are shown to the user automatically, so describe what a chart SHOWS ' +
        'rather than restating its numbers.',
      inputSchema: z.object({
        code: z.string().describe('Python source. Print results you want to see.'),
        /** Named so the user can tell one script from another in the workspace. */
        label: z
          .string()
          .default('analysis')
          .describe('Two or three words describing what this does, for the filename'),
      }),
      execute: async ({ code, label }) => {
        // Asked once per session rather than once per call. See the note above.
        const decision = await options.approvals.request(
          'Run Python in the workspace',
          { code: code.slice(0, 2_000), lines: code.split('\n').length },
          { scope: PYTHON_SCOPE },
        )
        if (decision === 'deny') return { ok: false, reason: 'Denied by user' }

        const scriptPath = `${directory}/${slug(label)}.py`
        await options.workspace.write(scriptPath, code)

        const before = await listFiles(options.workspace)

        // Run from the workspace root so relative paths in the script mean what
        // the model expects, and unbuffered so a script that times out still
        // returns whatever it managed to print.
        const result = await options.workspace.exec(`python3 -u ".${scriptPath}"`, {
          timeoutMs,
          env: {
            // Agg has no display. Without it matplotlib picks an interactive
            // backend, fails to find one, and takes the script down with it.
            MPLBACKEND: 'Agg',
            PYTHONDONTWRITEBYTECODE: '1',
          },
        })

        const after = await listFiles(options.workspace)
        const created = [...after].filter((path) => !before.has(path) && path !== scriptPath)

        // The mistake is common enough, and quiet enough, to be worth naming
        // when the script ran fine and produced nothing the workspace can see.
        const wroteOutside =
          result.exitCode === 0 &&
          created.length === 0 &&
          /\b(?:open|savefig|to_csv|to_excel|to_parquet|write_text)\s*\(\s*["']\//.test(code)

        for (const path of created) {
          options.emit({
            type: 'workspace.file.changed',
            runId: 'ui',
            ts: Date.now(),
            path,
            op: 'created',
          })
        }

        const charts = created.filter((path) =>
          IMAGE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension)),
        )

        return {
          ok: result.exitCode === 0 && !result.timedOut,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, maxOutput),
          // Kept even on success: a warning is often the explanation for a
          // number that looks wrong.
          stderr: result.stderr.slice(0, 4_000),
          truncated: result.stdout.length > maxOutput,
          timedOut: result.timedOut,
          script: scriptPath,
          ...(created.length > 0 ? { created } : {}),
          ...(wroteOutside
            ? {
                warning:
                  'The script wrote to a path starting with "/", which is the machine\'s ' +
                  'filesystem root, not the workspace — nothing appeared in the workspace. ' +
                  'Use a relative path such as "charts/name.png" instead.',
              }
            : {}),
          ...(charts.length > 0
            ? {
                charts,
                note: 'These are shown to the user. Say what they show; do not restate the numbers.',
              }
            : {}),
        }
      },
    }),
  }
}

/**
 * Every file in the workspace, for the before-and-after comparison.
 *
 * A walk rather than a watcher: the workspace seam has no change notification,
 * and adding one for this would be a lot of machinery to learn that a script
 * wrote a PNG. Bounded, and skipping the directories that would dominate it.
 */
async function listFiles(workspace: Workspace): Promise<Set<string>> {
  const seen = new Set<string>()
  const queue = ['/']
  const skip = new Set(['node_modules', '.git', '.checkpoints', '.elided', '.render', '__pycache__'])
  let visited = 0

  while (queue.length > 0 && visited < 5_000) {
    const directory = queue.shift()!
    const entries = await workspace.list(directory).catch(() => [])
    for (const entry of entries) {
      if (entry.type === 'directory') {
        if (!skip.has(entry.name)) queue.push(entry.path)
      } else if (entry.type === 'file') {
        seen.add(entry.path)
        visited += 1
      }
    }
  }

  return seen
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'analysis'
  )
}
