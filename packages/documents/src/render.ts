import type { Workspace } from '@workspace/workspace'

/**
 * Turning a document into something you can look at.
 *
 * Two jobs, and they are the same job. The artifact pane needs a picture of a
 * .docx because no browser renders OOXML; and gate 3 of the verification loop
 * needs a picture of a .pptx because the only way to catch a deck that is
 * valid, recalculates, and still looks wrong is to look at it.
 *
 * Everything runs inside the workspace via `exec`, so on a Docker backing it
 * happens in the container rather than on the host. That is deliberate: a
 * model-authored document is untrusted input to LibreOffice, which is a large
 * C++ program with a long history of parser bugs.
 */

export interface RenderOptions {
  /** Density for rasterisation. 110 is readable on a normal screen. */
  dpi?: number
  maxPages?: number
  timeoutMs?: number
}

export interface RenderResult {
  ok: boolean
  /** Workspace paths of the rendered PNGs, in page order. */
  pages: string[]
  pdf?: string
  reason?: string
  /** Which rasteriser was used, since they differ in what they can do. */
  via?: 'poppler' | 'libreoffice'
}

const OFFICE = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'doc', 'ppt', 'xls'])

export function isRenderable(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return OFFICE.has(extension) || extension === 'pdf'
}

/**
 * Converts a document to PDF.
 *
 * Also the second verification gate: LibreOffice opening a file and writing it
 * out is a real parse and a real layout pass. A spreadsheet whose formulas do
 * not evaluate, or a deck with a corrupt relationship, fails here — which is
 * exactly the class of fault that XSD validation cannot see, because the
 * document is schema-valid and still wrong.
 */
export async function toPdf(
  workspace: Workspace,
  path: string,
  options: RenderOptions = {},
): Promise<{ ok: boolean; pdf?: string; reason?: string; stderr?: string }> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const outputDir = '/.render'
  const base = basename(path).replace(/\.[^.]+$/, '')

  if (path.toLowerCase().endsWith('.pdf')) return { ok: true, pdf: path }

  await workspace.mkdir(outputDir).catch(() => {})

  // Remove any previous conversion of this document. LibreOffice writes to a
  // fixed name and would otherwise leave the old PDF in place if the new
  // conversion failed — and the caller would then rasterise the old one and
  // believe it had rendered the new.
  await workspace.remove(`${outputDir}/${base}.pdf`).catch(() => {})

  // -env:UserInstallation gives each run its own profile directory. Without it
  // concurrent soffice invocations fight over a shared lock and one silently
  // produces nothing — which reads as "the document is broken".
  const result = await workspace.exec(
    `soffice --headless --norestore ` +
      `-env:UserInstallation=file:///tmp/lo-$$ ` +
      `--convert-to pdf --outdir "$OUTDIR" "$INPUT" 2>&1`,
    {
      timeoutMs,
      env: { OUTDIR: `.${outputDir}`, INPUT: `.${path}` },
    },
  )

  const pdf = `${outputDir}/${base}.pdf`
  if (!(await workspace.exists(pdf))) {
    return {
      ok: false,
      reason: result.timedOut
        ? `LibreOffice timed out after ${timeoutMs}ms`
        : 'LibreOffice produced no PDF',
      stderr: result.stdout.slice(0, 2_000),
    }
  }

  return { ok: true, pdf }
}

/**
 * Renders a document to one PNG per page.
 *
 * Prefers `pdftoppm`, which renders every page. Falls back to LibreOffice's own
 * PNG export, which renders only the FIRST — and says so via `via`, because a
 * caller checking a twenty-slide deck needs to know it is looking at slide one
 * rather than at a deck that turned out to be one slide long.
 */
export async function toImages(
  workspace: Workspace,
  path: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const dpi = options.dpi ?? 110
  const maxPages = options.maxPages ?? 20
  const timeoutMs = options.timeoutMs ?? 120_000

  const converted = await toPdf(workspace, path, options)
  if (!converted.ok || !converted.pdf) {
    return { ok: false, pages: [], ...(converted.reason ? { reason: converted.reason } : {}) }
  }

  const outputDir = '/.render'
  const base = basename(converted.pdf).replace(/\.pdf$/i, '')

  /*
   * Clear the previous render of THIS document first.
   *
   * pdftoppm writes one file per page and overwrites in place, so rendering a
   * four-page document and then a three-page one leaves page four behind. The
   * consequence is not cosmetic: gate 3 judges whatever pages it is handed, so
   * a corrected document would be reviewed against a page from the version
   * before the correction — and could fail, or pass, for reasons that no longer
   * exist in the file.
   */
  await clearPreviousPages(workspace, outputDir, `${base}-page`)

  const poppler = await workspace.exec('command -v pdftoppm', { timeoutMs: 10_000 })
  if (poppler.exitCode === 0) {
    await workspace.exec(
      `pdftoppm -png -r ${dpi} -l ${maxPages} "$INPUT" "$PREFIX"`,
      { timeoutMs, env: { INPUT: `.${converted.pdf}`, PREFIX: `.${outputDir}/${base}-page` } },
    )
    const pages = await listMatching(workspace, outputDir, `${base}-page`)
    if (pages.length > 0) {
      return { ok: true, pages: pages.slice(0, maxPages), pdf: converted.pdf, via: 'poppler' }
    }
  }

  // No poppler. LibreOffice can rasterise directly, but only the first page.
  const fallback = await workspace.exec(
    `soffice --headless --norestore -env:UserInstallation=file:///tmp/lo-png-$$ ` +
      `--convert-to png --outdir "$OUTDIR" "$INPUT" 2>&1`,
    { timeoutMs, env: { OUTDIR: `.${outputDir}`, INPUT: `.${path}` } },
  )

  const single = `${outputDir}/${basename(path).replace(/\.[^.]+$/, '')}.png`
  if (await workspace.exists(single)) {
    return { ok: true, pages: [single], pdf: converted.pdf, via: 'libreoffice' }
  }

  return {
    ok: false,
    pages: [],
    pdf: converted.pdf,
    reason: `Could not rasterise. Install poppler-utils for multi-page rendering. ${fallback.stdout.slice(0, 300)}`,
  }
}

async function clearPreviousPages(
  workspace: Workspace,
  directory: string,
  prefix: string,
): Promise<void> {
  const stale = await listMatching(workspace, directory, prefix)
  await Promise.all(stale.map((page) => workspace.remove(page).catch(() => {})))
}

async function listMatching(
  workspace: Workspace,
  directory: string,
  prefix: string,
): Promise<string[]> {
  const entries = await workspace.list(directory).catch(() => [])
  return entries
    .filter((e) => e.type === 'file' && e.name.startsWith(prefix) && e.name.endsWith('.png'))
    // pdftoppm zero-pads, so lexicographic order is page order — but only
    // because it pads. Sorted numerically anyway, since that does not depend on
    // a detail of another program's output format.
    .sort((a, b) => pageNumber(a.name) - pageNumber(b.name))
    .map((e) => e.path)
}

function pageNumber(name: string): number {
  const match = name.match(/-(\d+)\.png$/)
  return match ? Number(match[1]) : 0
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}
