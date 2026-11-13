// Dabir's panel beside the chat in Claude Code: whether the paper's LaTeX holds together, each change the
// agent made to it with its diff and an Undo, and one press to compile and open the PDF.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Build, Change, Check, Finding, Paper } from '../types'

const PANE = 'dabir'
const paper = atom({ plugin: 'dabir-panel', key: 'paper' } as const, null, { shape: 'paper-1' })
const check = atom({ plugin: 'dabir-panel', key: 'check' } as const, null, { shape: 'check-1' })
const changes = atom({ plugin: 'dabir-panel', key: 'changes' } as const, [], { shape: 'changes-1' })
const build = atom({ plugin: 'dabir-panel', key: 'build' } as const, null, { shape: 'build-1' })
const busy = atom({ plugin: 'dabir-panel', key: 'busy' } as const, '')

// Dabir's madder, for the mark only; status takes the host's own success and error colours.
const MADDER = '#c4463f'
const SHOWN = 5

type $ = EngineInterface

const dirname = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf('/')))
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const isPaperFile = (p: string | undefined): p is string => !!p && /\.(tex|bib)$/.test(p)
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The main file of the paper in `dir`, found the way dabir-check finds it. */
async function findMain($: $, dir: string): Promise<string | null> {
  if (await $.fs.exists(`${dir}/dabir.toml`)) {
    const m = /^\s*main\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(await $.fs.read(`${dir}/dabir.toml`))
    const named = m?.[1]
    if (named && (await $.fs.exists(`${dir}/${named}`))) return named
  }
  if (await $.fs.exists(`${dir}/main.tex`)) return 'main.tex'
  const tex = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.tex')).slice(0, 20)
  for (const f of tex) if ((await $.fs.read(`${dir}/${f.name}`)).includes('\\documentclass')) return f.name
  return null
}

/** dabir-check's report: `file:line: error: message`, warnings alike, then a summary line. */
export function parseCheck(out: string): { errors: Finding[]; warnings: Finding[] } {
  const errors: Finding[] = []
  const warnings: Finding[] = []
  for (const line of out.split('\n')) {
    const m = /^(.+?): (error|warning): (.*)$/.exec(line)
    if (m) (m[2] === 'error' ? errors : warnings).push({ at: m[1] ?? '', message: m[3] ?? '' })
  }
  return { errors, warnings }
}

const CONTEXT = 1
const CONTEXT_CHARS = 72

/**
 * A tool's hunks as unified diff text the Code element draws; tabs and returns are not allowed there.
 * A LaTeX paragraph is one long line, so context is cut to one line each side and shortened; the
 * changed lines stay whole. The header follows the context it keeps, so the hunk still parses.
 */
export function toDiff(hunks: readonly { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: readonly string[] }[]) {
  let added = 0
  let removed = 0
  const text = hunks
    .map(h => {
      for (const l of h.lines) {
        if (l.startsWith('+')) added += 1
        else if (l.startsWith('-')) removed += 1
      }
      const changed = h.lines.flatMap((l, i) => (l.startsWith('+') || l.startsWith('-') ? [i] : []))
      const first = Math.max(0, (changed[0] ?? 0) - CONTEXT)
      const last = Math.min(h.lines.length, (changed[changed.length - 1] ?? h.lines.length - 1) + CONTEXT + 1)
      const tail = h.lines.length - last
      const lines = h.lines
        .slice(first, last)
        .map(l => (l.startsWith(' ') && l.length > CONTEXT_CHARS ? `${l.slice(0, CONTEXT_CHARS)}…` : l))
      const head = `@@ -${h.oldStart + first},${h.oldLines - first - tail} +${h.newStart + first},${h.newLines - first - tail} @@`
      return [head, ...lines].join('\n')
    })
    .join('\n')
    .replace(/\t/g, '  ')
    .replace(/\r/g, '')
  return { text, added, removed }
}

/** Takes one edit back if its text is still there exactly once; otherwise leaves the file alone. */
export function reverse(text: string, c: Pick<Change, 'tool' | 'oldText' | 'newText'>): string | null {
  if (c.tool === 'Write') return text === c.newText ? c.oldText : null
  const at = text.indexOf(c.newText)
  if (c.newText === '' || at < 0 || text.indexOf(c.newText, at + 1) >= 0) return null
  return text.slice(0, at) + c.oldText + text.slice(at + c.newText.length)
}

async function locate($: $, from: string): Promise<Paper | null> {
  const stop = await $.session.root()
  for (let dir = from; ; dir = dirname(dir)) {
    const main = await findMain($, dir).catch(() => null)
    if (main) {
      const pdf = `${dir}/${main.replace(/\.tex$/, '.pdf')}`
      return { root: dir, main, pdf: (await $.fs.exists(pdf)) ? pdf : null }
    }
    if (dir === stop || dir === '/' || !dir.startsWith(stop)) return null
  }
}

async function runCheck($: $) {
  const p = await read($, paper)
  if (!p) return
  const r = await $.process
    .run([`${$.plugin.root}/scripts/dabir-check`, p.main], { cwd: p.root, timeoutMs: 60_000 })
    .catch(() => null)
  const found = parseCheck(r ? r.stdout : '')
  const result: Check = { ...found, isMissing: !r || r.exitCode === 3, at: await $.clock.now() }
  await update($, check, () => result)
  $.ui.status(result.isMissing ? undefined : result.errors.length ? `Dabir · ${result.errors.length} error${result.errors.length > 1 ? 's' : ''}` : 'Dabir ✓')
}

async function compile($: $) {
  const p = await read($, paper)
  if (!p || (await read($, busy))) return
  await update($, busy, () => 'Compiling…')
  const m = quote(p.main)
  const cmd = `if command -v tectonic >/dev/null 2>&1; then tectonic -X compile --keep-logs --synctex ${m}; elif command -v latexmk >/dev/null 2>&1; then latexmk -pdf -interaction=nonstopmode -halt-on-error ${m}; else echo 'Install Tectonic or a TeX distribution with latexmk to compile.' >&2; exit 127; fi`
  const r = await $.process.run(['/bin/sh', '-lc', cmd], { cwd: p.root, timeoutMs: 300_000 }).catch(e => ({ exitCode: 1, stdout: '', stderr: String(e) }))
  const pdf = `${p.root}/${p.main.replace(/\.tex$/, '.pdf')}`
  const isOk = r.exitCode === 0 && (await $.fs.exists(pdf))
  const out = `${r.stdout}\n${r.stderr}`.split('\n')
  const message = isOk ? 'Compiled' : (out.find(l => l.startsWith('!') || /error/i.test(l)) ?? out.filter(Boolean).slice(-1)[0] ?? 'Compile failed').slice(0, 200)
  const at = await $.clock.now()
  await update($, build, (): Build => ({ isOk, message, at }))
  if (isOk) await update($, paper, x => (x ? { ...x, pdf } : x))
  await update($, busy, () => '')
  if (isOk) await openPdf($)
}

async function openPdf($: $) {
  const p = await read($, paper)
  if (!p?.pdf) return
  // In the desktop app the PDF opens in the side panel, as Claude shows files; elsewhere in the system viewer.
  const canShow = (await $.tool.list()).some(t => t.name === 'SendUserFile')
  const shown = canShow
    ? await $.tool.call({ tool: 'SendUserFile', files: [p.pdf], display: 'render', status: 'normal' }).catch(() => null)
    : null
  if (shown && shown.deny === undefined && !shown.isError) return
  const viewer = await $.process.run(['open', p.pdf]).catch(() => null)
  if (!viewer || viewer.exitCode !== 0) await $.process.run(['xdg-open', p.pdf]).catch(() => $.ui.toast(`The PDF is at ${p.pdf}`))
}

async function undo($: $, id: string) {
  const c = (await read($, changes)).find(x => x.id === id)
  if (!c || c.isUndone) return
  const now = await $.fs.read(c.file).catch(() => null)
  const back = now === null ? null : reverse(now, c)
  if (back === null) {
    $.ui.toast('That text has changed since; ask Claude to undo it.')
    return
  }
  await $.fs.write(c.file, back)
  await update($, changes, list => list.map(x => (x.id === id ? { ...x, isUndone: true } : x)))
  await runCheck($)
}

// Before a window is attached (a reload, a headless run) there is nowhere to open it; /dabir-panel opens it later.
async function show($: $) {
  if ((await $.session.surfaces()).length) await $.ui.open({ id: PANE, title: 'Dabir' }).catch(() => undefined)
}

// Every edit the agent makes to the paper: kept for the panel, then the paper is checked again.
async function record($: $, file: string, tool: 'Edit' | 'Write', oldText: string, newText: string, hunks: Parameters<typeof toDiff>[0], id: string) {
  if (!(await read($, paper))) {
    const found = await locate($, dirname(file)).catch(() => null)
    if (!found) return
    await update($, paper, () => found)
    void show($)
  }
  const d = toDiff(hunks)
  const c: Change = { id, file, tool, oldText, newText, diff: d.text, added: d.added, removed: d.removed, at: await $.clock.now(), isUndone: false }
  await update($, changes, list => [...list, c].slice(-50))
  await runCheck($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dabir-panel', description: 'Show the Dabir panel: LaTeX check, the agent’s changes, compile and PDF' })
    const found = await locate($, await $.session.cwd()).catch(() => null)
    if (found) {
      await update($, paper, () => found)
      void show($)
      void runCheck($)
    }
    return next(e)
  })

  on('command.run', { command: 'dabir-panel' }, async $ => {
    if (!(await read($, paper))) {
      const found = await locate($, await $.session.cwd()).catch(() => null)
      if (!found) return { text: 'No LaTeX paper here: open a folder with a main .tex file.' }
      await update($, paper, () => found)
    }
    await show($)
    void runCheck($)
    return { text: 'Dabir panel opened.' }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && isPaperFile(e.file_path) && ran.result) {
      const r = ran.result
      await record($, e.file_path, 'Edit', r.oldString, r.newString, r.structuredPatch, e.tool_use_id)
    }
    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && isPaperFile(e.file_path) && ran.result) {
      const r = ran.result
      await record($, e.file_path, 'Write', r.originalFile ?? '', e.content, r.structuredPatch, e.tool_use_id)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const p = await read($, paper)
    if (!p) return <Text dimColor>No LaTeX paper in this folder.</Text>
    const c = await read($, check)
    const b = await read($, build)
    const working = await read($, busy)
    const list = (await read($, changes)).filter(x => !x.isUndone)
    const rel = (f: string) => (f.startsWith(`${p.root}/`) ? f.slice(p.root.length + 1) : basename(f))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Text>
            <Text color={MADDER} weight="semibold">‸ Dabir</Text>
            <Text dimColor> {p.main}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="check" label="Check" variant="secondary" onPress={() => void runCheck($)} />
            <Button key="compile" label={working || 'Compile'} variant="secondary" onPress={() => void compile($)} />
            {p.pdf && <Button key="pdf" label="Open PDF" variant="primary" onPress={() => void openPdf($)} />}
          </Box>
        </Box>

        {c === null && <Text dimColor>Checking…</Text>}
        {c?.isMissing && <Text dimColor>dabir-check is not available yet: it downloads on first use and needs the network once.</Text>}
        {c && !c.isMissing && c.errors.length === 0 && (
          <Text color="success">✓ The LaTeX holds together{c.warnings.length ? `, ${c.warnings.length} warning${c.warnings.length > 1 ? 's' : ''}` : ''}</Text>
        )}
        {c && c.errors.length > 0 && (
          <Box flexDirection="column">
            <Text color="error" weight="semibold">✗ {c.errors.length} error{c.errors.length > 1 ? 's' : ''} a compile would stop on</Text>
            {c.errors.slice(0, 6).map(f => (
              <Text wrap="wrap">
                <Text mono dimColor>{f.at}</Text> {f.message}
              </Text>
            ))}
            <Box marginTop={1}>
              <Button
                key="fix"
                label="Ask Claude to fix these"
                onPress={() => void $.prompt.submit({ text: `Fix the LaTeX errors dabir-check reports in ${p.main}:\n${c.errors.map(f => `${f.at}: ${f.message}`).join('\n')}` })}
              />
            </Box>
          </Box>
        )}
        {b && <Text color={b.isOk ? 'success' : 'error'} wrap="wrap">{b.isOk ? '✓ Compiled' : `✗ ${b.message}`}</Text>}

        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Changes this session{list.length ? ` (${list.length})` : ''}</Text>
          {list.length === 0 && <Text dimColor>Edits the agent makes to the paper appear here, each with its diff and an Undo.</Text>}
          {list.slice(-SHOWN).reverse().map(x => (
            <Box key={x.id} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Text>
                  <Text mono>{rel(x.file)}</Text>
                  <Text color="diffAdded"> +{x.added}</Text>
                  <Text color="diffRemoved"> −{x.removed}</Text>
                </Text>
                <Button key={`undo-${x.id}`} label="Undo" plain onPress={() => void undo($, x.id)} />
              </Box>
              {x.diff && <Code source={x.diff} format="diff" path={x.file} wrap="truncate-end" />}
            </Box>
          ))}
          {list.length > SHOWN && <Text dimColor>and {list.length - SHOWN} earlier.</Text>}
        </Box>
      </Box>
    )
  })
}
