// What the panel reviews: the paper's text now against the text the author last reviewed.
// Pure functions only, so they test without a host.
import { createHash } from 'node:crypto'
import { diffLines } from 'diff'

export type Line = { t: 'ctx' | 'add' | 'del'; s: string }
export type Hunk = { id: string; oldLine: number; newLine: number; added: number; removed: number; lines: Line[] }
type Part = { same: string } | { id: string; old: string; new: string; oldLine: number; newLine: number }

const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// The base and current text cut into unchanged runs and changed runs; a changed run is one hunk.
function parts(base: string, current: string): Part[] {
  const out: Part[] = []
  let oldLine = 1
  let newLine = 1
  let open: { old: string; new: string; oldLine: number; newLine: number } | null = null
  const close = () => {
    if (!open) return
    const id = createHash('sha1').update(`${open.oldLine}\0${open.old}\0${open.new}`).digest('hex').slice(0, 12)
    out.push({ id, ...open })
    open = null
  }
  for (const c of diffLines(base, current)) {
    const n = c.count ?? lines(c.value).length
    if (!c.added && !c.removed) {
      close()
      out.push({ same: c.value })
      oldLine += n
      newLine += n
      continue
    }
    open ??= { old: '', new: '', oldLine, newLine }
    if (c.removed) {
      open.old += c.value
      oldLine += n
    } else {
      open.new += c.value
      newLine += n
    }
  }
  close()
  return out
}

/** Every change from base to current, with one line of context each side. */
export function hunks(base: string, current: string): Hunk[] {
  const ps = parts(base, current)
  return ps.flatMap((p, i) => {
    if ('same' in p) return []
    const before = ps[i - 1]
    const after = ps[i + 1]
    const ctxBefore = before && 'same' in before ? lines(before.same).slice(-1) : []
    const ctxAfter = after && 'same' in after ? lines(after.same).slice(0, 1) : []
    const del = lines(p.old)
    const add = lines(p.new)
    return [{
      id: p.id,
      oldLine: p.oldLine,
      newLine: p.newLine,
      added: add.length,
      removed: del.length,
      lines: [
        ...ctxBefore.map((s): Line => ({ t: 'ctx', s })),
        ...del.map((s): Line => ({ t: 'del', s })),
        ...add.map((s): Line => ({ t: 'add', s })),
        ...ctxAfter.map((s): Line => ({ t: 'ctx', s })),
      ],
    }]
  })
}

/**
 * Settle some hunks. Keep moves a change into the reviewed text; undo takes it out of the paper.
 * Hunks named in neither list stay pending. An id that no longer exists means the text moved on.
 */
export function settle(base: string, current: string, keep: string[], undo: string[]) {
  const ps = parts(base, current)
  const known = new Set(ps.flatMap((p) => ('id' in p ? [p.id] : [])))
  const missing = [...keep, ...undo].filter((id) => !known.has(id))
  if (missing.length) return null
  let b = ''
  let c = ''
  for (const p of ps) {
    if ('same' in p) {
      b += p.same
      c += p.same
    } else if (keep.includes(p.id)) {
      b += p.new
      c += p.new
    } else if (undo.includes(p.id)) {
      b += p.old
      c += p.old
    } else {
      b += p.old
      c += p.new
    }
  }
  return { base: b, current: c }
}

export type Finding = { at: string; message: string }

/** dabir-check prints `file:line: error: message`; read that into errors and warnings. */
export function parseCheck(out: string) {
  const errors: Finding[] = []
  const warnings: Finding[] = []
  for (const line of out.split('\n')) {
    const m = /^(.+?): (error|warning): (.*)$/.exec(line)
    if (m) (m[2] === 'error' ? errors : warnings).push({ at: m[1]!, message: m[3]! })
  }
  return { errors, warnings }
}

/** The main file: `main =` in dabir.toml, else main.tex, else the first .tex with \documentclass. */
export function pickMain(toml: string | null, texFiles: { name: string; text: string }[]) {
  const named = toml && /^\s*main\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
  if (named) return named
  if (texFiles.some((f) => f.name === 'main.tex')) return 'main.tex'
  return texFiles.find((f) => /\\documentclass/.test(f.text))?.name ?? null
}

/** The first lines of a TeX log that say what stopped the compile. */
export function compileErrors(log: string) {
  const picked = log.split('\n').filter((l) => /^(error|!|.*:\d+: )/.test(l.trim()))
  return picked.slice(0, 6).join('\n')
}

// ---- SyncTeX: source lines to PDF positions and back, as src-tauri/src/synctex.rs does it ----

type Rec = { page: number; file: number; line: number; x: number; y: number }
export type Sync = { files: Map<number, string>; recs: Rec[] }

/** Read a .synctex stream: `Input:<n>:<path>` lines, `{<page>` blocks and `h<file>,<line>:<x>,<y>…` records, in points from the page's top left. */
export function parseSynctex(text: string): Sync {
  const files = new Map<number, string>()
  const recs: Rec[] = []
  let unit = 1
  let page = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('Input:')) {
      const m = /^Input:(\d+):(.*)$/.exec(line)
      if (m) files.set(Number(m[1]), m[2]!.trim())
    } else if (line.startsWith('Unit:')) unit = Number(line.slice(5)) || 1
    else if (line.startsWith('{')) page = Number(line.slice(1)) || page
    else {
      const m = /^[hvxkg$r[(](\d+),(\d+):(-?\d+),(-?\d+)/.exec(line)
      if (m) recs.push({ page, file: Number(m[1]), line: Number(m[2]), x: (Number(m[3]) * unit) / 65536, y: (Number(m[4]) * unit) / 65536 })
    }
  }
  return { files, recs }
}

const base = (p: string) => p.split(/[\\/]/).pop()

/** Where a source line landed: the nearest record at or after it in the same file. */
export function toPdf(s: Sync, file: string, line: number) {
  const ids = [...s.files].filter(([, p]) => base(p) === base(file)).map(([id]) => id)
  let best: Rec | null = null
  for (const r of s.recs) {
    if (!ids.includes(r.file) || r.line < line) continue
    if (!best || r.line - line < best.line - line || (r.line === best.line && r.y < best.y)) best = r
  }
  return best && { page: best.page, x: best.x, y: best.y }
}

/** The source line nearest a point on a page; vertical distance counts four times horizontal. */
export function toSource(s: Sync, page: number, x: number, y: number) {
  let best: Rec | null = null
  let dist = Infinity
  for (const r of s.recs) {
    if (r.page !== page || !s.files.get(r.file)) continue // Tectonic leaves package files without a path
    const d = Math.abs(r.y - y) * 4 + Math.abs(r.x - x)
    if (d < dist) {
      dist = d
      best = r
    }
  }
  return best && { file: s.files.get(best.file) ?? '', line: best.line }
}
