// Dabir as an MCP server. Claude reads and edits the paper through it, and its panel
// (view.html, an MCP App) shows the PDF and every change since the author last reviewed.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import { compileErrors, hunks, parseCheck, pickMain, settle } from './paper.ts'

declare const __VERSION__: string
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIEW = 'ui://dabir/panel.html'
const TEXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.txt', '.md'])
const REVIEWED = new Set(['.tex', '.bib'])
const CHUNK = 512 * 1024
const SKIP = new Set(['node_modules', 'build', 'out', 'dist', '_minted'])

const text = (s: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: s }], isError })

// ---- The paper on disk ----

async function folderOf(folder: string) {
  const dir = path.resolve(folder.replace(/^~(?=$|\/)/, os.homedir()))
  const st = await fs.stat(dir).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`${folder} is not a folder on this computer.`)
  // A paper is a folder of its own; the home folder or a disk would open every text file under it.
  if (dir === os.homedir() || dir === path.parse(dir).root) throw new Error(`${dir} is not a paper's folder. Name the folder that holds the .tex files.`)
  return dir
}

/** A file inside the paper's folder, never outside it, and only a kind of text a paper is made of. */
function inside(dir: string, file: string) {
  const abs = path.resolve(dir, file)
  const rel = path.relative(dir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside the paper's folder.`)
  if (!TEXT.has(path.extname(abs).toLowerCase())) throw new Error(`${file} is not a LaTeX, BibTeX or text file.`)
  return { abs, rel: rel.split(path.sep).join('/') }
}

async function walk(dir: string, rel = '', depth = 0): Promise<string[]> {
  if (depth > 4) return []
  const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(dir, r, depth + 1)))
    else if (REVIEWED.has(path.extname(e.name).toLowerCase())) out.push(r)
    if (out.length > 400) break
  }
  return out.sort()
}

async function mainOf(dir: string, files: string[]) {
  const toml = await fs.readFile(path.join(dir, 'dabir.toml'), 'utf8').catch(() => null)
  const tex = await Promise.all(files.filter((f) => f.endsWith('.tex')).map(async (name) => ({ name, text: (await fs.readFile(path.join(dir, name), 'utf8')).slice(0, 4000) })))
  return pickMain(toml, tex)
}

// ---- The reviewed text: a copy of each file as the author last accepted it, kept outside the paper ----

function cacheRoot() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache')
}
const reviewDir = (dir: string) => path.join(cacheRoot(), 'dabir', 'review', createHash('sha256').update(dir).digest('hex').slice(0, 16))
const basePath = (dir: string, rel: string) => path.join(reviewDir(dir), encodeURIComponent(rel))

/** The reviewed copy of a file. The first time a file is seen, what is on disk is what has been reviewed. */
async function baseOf(dir: string, rel: string, current: string) {
  const p = basePath(dir, rel)
  const saved = await fs.readFile(p, 'utf8').catch(() => null)
  if (saved !== null) return saved
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, current)
  return current
}

// ---- Tools the server runs: dabir-check and the TeX engine ----

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeout = 300_000) {
  return new Promise<{ code: number; out: string; isMissing: boolean }>((resolve) => {
    execFile(cmd, args, { cwd, env, timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolve({ code, out: `${stdout}${stderr}`, isMissing: err?.code === 'ENOENT' })
    })
  })
}

const PLATFORM = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows-x86_64.exe' : `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`

/** dabir-check: $DABIR_CHECK (tests), else shipped beside the server, else the one the Claude Code plugin downloaded, else on PATH. */
function checker() {
  if (process.env.DABIR_CHECK) return process.env.DABIR_CHECK
  const shipped = path.join(HERE, 'bin', `dabir-check-${PLATFORM}`)
  if (existsSync(shipped)) {
    try { chmodSync(shipped, 0o755) } catch { /* read-only install: it was packed executable */ }
    return shipped
  }
  const cached = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'dabir', VERSION, 'dabir-check')
  return existsSync(cached) ? cached : 'dabir-check'
}

async function check(dir: string, main: string | null) {
  if (!main) return { errors: [], warnings: [], report: 'No main .tex file found in this folder.', isMissing: true }
  const r = await run(checker(), [main], dir, undefined, 30_000)
  if (r.code !== 0 && r.code !== 1) return { errors: [], warnings: [], report: 'dabir-check is not available on this computer.', isMissing: true }
  return { ...parseCheck(r.out), report: r.out.trim(), isMissing: false }
}

// A desktop app starts this server with a short PATH; ask the user's login shell for theirs once.
let loginPath: Promise<string> | null = null
function userPath() {
  loginPath ??= process.platform === 'win32'
    ? Promise.resolve(process.env.PATH ?? '')
    : run(process.env.SHELL || '/bin/sh', ['-lc', 'printf %s "$PATH"'], os.homedir(), undefined, 10_000).then((r) => (r.code === 0 && r.out ? r.out : process.env.PATH ?? ''))
  return loginPath
}

type Build = { isOk: boolean; message: string; at: number }
const builds = new Map<string, Build>()
const compiling = new Map<string, Promise<Build>>()
const timers = new Map<string, NodeJS.Timeout>()

/** One compile per folder at a time: a second request waits for the one running. */
function compile(dir: string, main: string): Promise<Build> {
  const running = compiling.get(dir)
  if (running) return running
  const job = compileNow(dir, main).finally(() => compiling.delete(dir))
  compiling.set(dir, job)
  return job
}

async function compileNow(dir: string, main: string): Promise<Build> {
  {
    const env = { ...process.env, PATH: await userPath() }
    const bundled = '/Applications/Dabir.app/Contents/MacOS/tectonic'
    const tectonic = existsSync(bundled) ? bundled : 'tectonic'
    let r = await run(tectonic, ['-X', 'compile', main, '--keep-logs', '--synctex'], dir, env)
    if (r.isMissing) r = await run('latexmk', ['-pdf', '-interaction=nonstopmode', main], dir, env)
    const missing = r.isMissing
    const build = {
      isOk: r.code === 0,
      message: r.code === 0 ? 'Compiled' : missing ? 'No TeX engine found. Install Tectonic (brew install tectonic) or the Dabir app.' : compileErrors(r.out) || r.out.trim().split('\n').slice(-6).join('\n'),
      at: Date.now(),
    }
    builds.set(dir, build)
    return build
  }
}

/** Compile a moment after the paper changes, if it holds together, so the PDF is current by the time anyone looks. */
function compileSoon(dir: string) {
  clearTimeout(timers.get(dir))
  timers.set(dir, setTimeout(async () => {
    timers.delete(dir)
    const files = await walk(dir)
    const main = await mainOf(dir, files)
    if (main && (await check(dir, main)).errors.length === 0) await compile(dir, main)
  }, 1200))
}

const pdfOf = (main: string) => main.replace(/\.tex$/, '.pdf')

// ---- What the panel shows ----

async function state(dir: string) {
  const files = await walk(dir)
  const main = await mainOf(dir, files)
  const changes = []
  for (const rel of files) {
    const current = await fs.readFile(path.join(dir, rel), 'utf8')
    const hs = hunks(await baseOf(dir, rel, current), current)
    if (hs.length) changes.push({ file: rel, added: hs.reduce((n, h) => n + h.added, 0), removed: hs.reduce((n, h) => n + h.removed, 0), hunks: hs })
  }
  const pdf = main ? await fs.stat(path.join(dir, pdfOf(main))).catch(() => null) : null
  return {
    folder: dir,
    where: dir.startsWith(os.homedir()) ? `~${dir.slice(os.homedir().length)}` : dir,
    main,
    files,
    check: await check(dir, main),
    changes,
    pdf: pdf ? { path: pdfOf(main!), size: pdf.size, mtime: pdf.mtimeMs } : null,
    build: builds.get(dir) ?? null,
    isCompiling: compiling.has(dir) || timers.has(dir),
  }
}

function summary(s: Awaited<ReturnType<typeof state>>) {
  const pending = s.changes.reduce((n, c) => n + c.hunks.length, 0)
  return [
    `Paper: ${s.folder}`,
    `Main file: ${s.main ?? 'none found'}. Files: ${s.files.join(', ') || 'none'}.`,
    s.check.isMissing ? s.check.report : `dabir-check: ${s.check.errors.length} errors, ${s.check.warnings.length} warnings.${s.check.report ? `\n${s.check.report}` : ''}`,
    pending ? `${pending} changes are waiting for the author's review in the Dabir panel.` : 'No changes are waiting for review.',
  ].join('\n')
}

// ---- The server ----

function createServer() {
  const server = new McpServer({ name: 'dabir', version: VERSION })
  const folder = z.string().describe('Absolute path of the folder that holds the paper')

  registerAppTool(server, 'open_paper', {
    title: 'Open the paper in Dabir',
    description: 'Open a LaTeX paper in the Dabir panel, which shows its PDF and every change waiting for the author\'s review. Call this first, before reading or editing the paper, and again whenever the author asks to see the paper.',
    inputSchema: z.object({ folder }),
    _meta: { ui: { resourceUri: VIEW } },
  }, async ({ folder: f }) => {
    try {
      const dir = await folderOf(f)
      const s = await state(dir)
      const pdfAge = s.pdf?.mtime ?? 0
      const texAge = s.main ? (await fs.stat(path.join(dir, s.main))).mtimeMs : 0
      if (s.main && texAge > pdfAge) compileSoon(dir)
      return { content: [{ type: 'text', text: summary(s) }], structuredContent: { folder: dir } }
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  server.registerTool('read_paper_file', {
    title: 'Read a file of the paper',
    description: 'Read a .tex, .bib or other text file of the paper, as it is on disk now.',
    inputSchema: z.object({ folder, file: z.string().describe('Path inside the folder, such as main.tex') }),
    annotations: { readOnlyHint: true },
  }, async ({ folder: f, file }) => {
    try {
      const { abs } = inside(await folderOf(f), file)
      return text(await fs.readFile(abs, 'utf8'))
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  server.registerTool('edit_paper', {
    title: 'Edit the paper',
    description: 'Replace one exact passage in a file of the paper. old_text must appear exactly once; include enough surrounding text to make it unique. The change appears in the Dabir panel, where the author keeps or undoes it, and dabir-check runs on the result. Make the smallest edit that does the job.',
    inputSchema: z.object({
      folder,
      file: z.string().describe('Path inside the folder, such as main.tex'),
      old_text: z.string().describe('The exact text to replace'),
      new_text: z.string().describe('The text to put in its place'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ folder: f, file, old_text, new_text }) => {
    try {
      const dir = await folderOf(f)
      const { abs, rel } = inside(dir, file)
      const current = await fs.readFile(abs, 'utf8')
      const at = current.indexOf(old_text)
      if (old_text === '' || at < 0) return text(`old_text was not found in ${rel}. Read the file again; the author may have undone or changed it.`, true)
      if (current.indexOf(old_text, at + 1) >= 0) return text(`old_text appears more than once in ${rel}. Include more surrounding text.`, true)
      await baseOf(dir, rel, current)
      await fs.writeFile(abs, current.slice(0, at) + new_text + current.slice(at + old_text.length))
      const main = await mainOf(dir, await walk(dir))
      const c = await check(dir, main)
      if (c.errors.length === 0) compileSoon(dir)
      return text(`Edited ${rel}. The change is waiting for the author's review in the Dabir panel.\n${c.isMissing ? '' : c.errors.length ? `dabir-check found errors; fix them:\n${c.report}` : 'dabir-check: no errors.'}`)
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  server.registerTool('check_paper', {
    title: 'Check the paper',
    description: 'Run dabir-check, which finds unbalanced braces, unclosed environments, missing labels, unknown citation keys and missing files in milliseconds, without compiling.',
    inputSchema: z.object({ folder }),
    annotations: { readOnlyHint: true },
  }, async ({ folder: f }) => {
    try {
      const dir = await folderOf(f)
      const c = await check(dir, await mainOf(dir, await walk(dir)))
      return text(c.report || 'dabir-check: no errors, no warnings.')
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  // The panel calls this too; a tool without a view is open to both.
  server.registerTool('compile_paper', {
    title: 'Compile the paper',
    description: 'Compile the paper to PDF with Tectonic (or latexmk). The Dabir panel shows the new PDF. Only needed when the author asks; the panel compiles by itself after each edit that passes dabir-check.',
    inputSchema: z.object({ folder }),
  }, async ({ folder: f }) => {
    try {
      const dir = await folderOf(f)
      const main = await mainOf(dir, await walk(dir))
      if (!main) return text('No main .tex file found in this folder.', true)
      const b = await compile(dir, main)
      return { content: [{ type: 'text', text: b.isOk ? `Compiled ${pdfOf(main)}.` : `The compile stopped:\n${b.message}` }], structuredContent: { folder: dir }, isError: !b.isOk }
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  // ---- Tools only the panel calls ----
  const appOnly = { ui: { resourceUri: VIEW, visibility: ['app'] as ('app' | 'model')[] } }

  registerAppTool(server, 'paper_state', {
    title: 'Paper state',
    description: 'What the Dabir panel shows. The model should not call this.',
    inputSchema: z.object({ folder }),
    _meta: appOnly,
  }, async ({ folder: f }) => {
    try {
      const s = await state(await folderOf(f))
      return { content: [{ type: 'text', text: summary(s) }], structuredContent: s }
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  registerAppTool(server, 'review_changes', {
    title: 'Keep or undo changes',
    description: 'The author keeps or undoes changes in the Dabir panel. The model should not call this.',
    inputSchema: z.object({ folder, file: z.string(), keep: z.array(z.string()), undo: z.array(z.string()) }),
    _meta: appOnly,
  }, async ({ folder: f, file, keep, undo }) => {
    try {
      const dir = await folderOf(f)
      const { abs, rel } = inside(dir, file)
      const current = await fs.readFile(abs, 'utf8')
      const settled = settle(await baseOf(dir, rel, current), current, keep, undo)
      if (!settled) return text(`${rel} changed since the panel last looked. Look again.`, true)
      await fs.writeFile(basePath(dir, rel), settled.base)
      if (settled.current !== current) {
        await fs.writeFile(abs, settled.current)
        compileSoon(dir)
      }
      const s = await state(dir)
      return { content: [{ type: 'text', text: summary(s) }], structuredContent: s }
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  registerAppTool(server, 'read_pdf', {
    title: 'Read the PDF',
    description: 'A piece of the compiled PDF for the Dabir panel. The model should not call this.',
    inputSchema: z.object({ folder, offset: z.number().int().min(0), mtime: z.number() }),
    _meta: appOnly,
  }, async ({ folder: f, offset, mtime }) => {
    try {
      const dir = await folderOf(f)
      const main = await mainOf(dir, await walk(dir))
      if (!main) return text('No main .tex file found.', true)
      const file = path.join(dir, pdfOf(main))
      const st = await fs.stat(file)
      if (st.mtimeMs !== mtime) return text('The PDF changed while it was being read.', true)
      const h = await fs.open(file)
      try {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - offset))
        await h.read(buf, 0, buf.length, offset)
        return { content: [{ type: 'text', text: `${buf.length} bytes` }], structuredContent: { bytes: buf.toString('base64'), offset, total: st.size, hasMore: offset + buf.length < st.size } }
      } finally {
        await h.close()
      }
    } catch (e) {
      return text(String((e as Error).message), true)
    }
  })

  registerAppResource(server, 'Dabir panel', VIEW, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: VIEW,
      mimeType: RESOURCE_MIME_TYPE,
      text: await fs.readFile(path.join(HERE, 'view.html'), 'utf8'),
      _meta: { ui: { preferredDisplayMode: 'fullscreen' } },
    }],
  }))

  return server
}

await createServer().connect(new StdioServerTransport())
