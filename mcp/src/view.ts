// The Dabir panel: an MCP App view. It asks the server for the paper's state every moment it is
// on screen, draws the PDF with pdf.js, and lets the author keep or undo each change.
import { App, applyDocumentTheme, type McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { diffWordsWithSpace } from 'diff'
import * as pdfjs from 'pdfjs-dist'
// pdf.js runs its worker on the main thread: a sandboxed view may not start workers. A paper is a few pages.
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs'

import { createEditor } from './editor.ts'
import type { Hunk } from './paper.ts'

;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker

type Finding = { at: string; message: string }
type Change = { file: string; added: number; removed: number; hunks: Hunk[] }
type State = {
  folder: string
  where: string
  main: string | null
  files: string[]
  mtimes: Record<string, number>
  check: { errors: Finding[]; warnings: Finding[]; report: string; isMissing: boolean }
  changes: Change[]
  pdf: { path: string; size: number; mtime: number } | null
  build: { isOk: boolean; message: string; at: number } | null
  isCompiling: boolean
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string | null)[]) => {
  const e = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) e.className = cls
  Object.assign(e, rest)
  for (const k of kids) if (k !== null) e.append(k)
  return e
}

declare const __VERSION__: string
const app = new App({ name: 'Dabir', version: __VERSION__ }, { availableDisplayModes: ['inline', 'fullscreen'] })
let folder: string | null = null
let state: State | null = null
type Tab = 'pdf' | 'source' | 'changes'
let tab: Tab | null = null
let shownPdf = 0
let polling = false

async function call<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
  const r = await app.callServerTool({ name, arguments: args })
  if (r.isError) {
    const msg = r.content?.find((c) => c.type === 'text')
    throw new Error(msg && 'text' in msg ? msg.text : `${name} failed`)
  }
  return (r.structuredContent as T) ?? null
}

// ---- Drawing ----

function draw(s: State) {
  state = s
  $('name').textContent = s.main ?? 'No main .tex file'
  $('path').textContent = s.where
  ;($('compile') as HTMLButtonElement).disabled = !s.main || s.isCompiling
  const pending = s.changes.reduce((n, c) => n + c.hunks.length, 0)
  const badge = $('badge')
  badge.hidden = pending === 0
  badge.textContent = String(pending)
  if (tab === null) select(pending ? 'changes' : 'pdf')
  drawStatus(s)
  drawChanges(s)
  drawFoot(s)
  if (tab === 'source') syncSource(s)
  if (s.pdf && s.pdf.mtime !== shownPdf) void loadPdf(s.folder, s.pdf.mtime)
  if (!s.pdf) $('pdf').replaceChildren(el('p', { class: 'empty' }, el('strong', {}, 'No PDF yet'), s.main ? 'Press Compile, or ask Claude to edit the paper; it compiles after each edit that holds together.' : 'This folder has no .tex file with \\documentclass.'))
}

function ask(text: string) {
  void app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }).catch(() => {})
}

function drawStatus(s: State) {
  const box = $('status')
  const { errors, warnings, isMissing, report } = s.check
  if (isMissing) {
    box.className = 'status quiet'
    box.replaceChildren(el('div', { class: 'head' }, el('span', { class: 'what' }, report)))
    return
  }
  if (errors.length) {
    box.className = 'status bad'
    box.replaceChildren(
      el('div', { class: 'head' },
        el('span', { class: 'what' }, `✗ ${errors.length} ${errors.length === 1 ? 'error' : 'errors'} a compile would stop on`),
        el('button', { class: 'btn small', onclick: () => ask(`Fix the LaTeX errors dabir-check reports in the paper at ${s.folder}:\n${errors.map((e) => `${e.at}: ${e.message}`).join('\n')}`) }, 'Ask Claude to fix')),
      el('ul', {}, ...errors.slice(0, 5).map((e) => el('li', {}, at(e.at), ' ', e.message))),
    )
    return
  }
  if (s.build && !s.build.isOk && !s.isCompiling) {
    box.className = 'status bad'
    box.replaceChildren(
      el('div', { class: 'head' },
        el('span', { class: 'what' }, '✗ The compile stopped'),
        el('button', { class: 'btn small', onclick: () => ask(`The paper at ${s.folder} does not compile:\n${s.build!.message}\nFix it.`) }, 'Ask Claude to fix')),
      el('pre', {}, s.build.message),
    )
    return
  }
  box.className = 'status ok'
  box.replaceChildren(el('div', { class: 'head' }, el('span', { class: 'what' }, warnings.length ? `✓ No errors · ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : '✓ The LaTeX holds together')))
  if (warnings.length) box.append(el('ul', {}, ...warnings.slice(0, 3).map((w) => el('li', {}, at(w.at), ' ', w.message))))
}

function drawChanges(s: State) {
  const pane = $('changes')
  if (!s.changes.length) {
    pane.replaceChildren(el('p', { class: 'empty' }, el('strong', {}, 'Nothing to review'), 'Each edit Claude makes to the paper appears here, with Keep and Undo.'))
    return
  }
  const total = s.changes.reduce((n, c) => n + c.hunks.length, 0)
  const all = (how: 'keep' | 'undo') => () => {
    for (const c of s.changes) void review(c.file, how === 'keep' ? c.hunks.map((h) => h.id) : [], how === 'undo' ? c.hunks.map((h) => h.id) : [])
  }
  pane.replaceChildren(
    el('div', { class: 'all' },
      el('span', {}, `${total} ${total === 1 ? 'change' : 'changes'} since you last reviewed`),
      el('button', { class: 'btn small danger', onclick: all('undo') }, 'Undo all'),
      el('button', { class: 'btn small primary', onclick: all('keep') }, 'Keep all')),
    ...s.changes.map((c) =>
      el('article', { class: 'diff' },
        el('header', {}, el('span', { class: 'file' }, c.file), el('span', { class: 'stat' }, el('span', { class: 'add' }, `+${c.added}`), el('span', { class: 'del' }, `−${c.removed}`))),
        ...c.hunks.map((h) => {
          const box = el('section', { class: 'hunk' },
            el('div', { class: 'row' },
              el('span', {}, el('button', { class: 'jump', title: 'Show in Source', onclick: () => void goTo(c.file, h.newLine) }, `line ${h.removed ? h.oldLine : h.newLine}`)),
              el('button', { class: 'btn small danger', onclick: () => { box.classList.add('busy'); void review(c.file, [], [h.id]) } }, 'Undo'),
              el('button', { class: 'btn small', onclick: () => { box.classList.add('busy'); void review(c.file, [h.id], []) } }, 'Keep')),
            el('pre', {}, ...lineNodes(h)))
          return box
        }))),
  )
}

/** Diff lines, with the changed words marked when a deleted line and an added line pair up: a LaTeX paragraph is one line. */
function lineNodes(h: Hunk) {
  const del = h.lines.filter((l) => l.t === 'del')
  const add = h.lines.filter((l) => l.t === 'add')
  const paired = del.length === add.length
  let d = 0
  let a = 0
  return h.lines.map((l) => {
    const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '
    const line = el('span', { class: `l ${l.t}` }, sign)
    const other = paired && l.t === 'del' ? add[d++]?.s : paired && l.t === 'add' ? del[a++]?.s : undefined
    if (other === undefined) {
      line.append(l.s || ' ')
      return line
    }
    const parts = l.t === 'del' ? diffWordsWithSpace(l.s, other) : diffWordsWithSpace(other, l.s)
    for (const p of parts) {
      if (l.t === 'del' ? p.added : p.removed) continue
      line.append((l.t === 'del' ? p.removed : p.added) ? el('span', { class: 'w' }, p.value) : p.value)
    }
    return line
  })
}

function drawFoot(s: State) {
  const foot = $('foot')
  if (s.isCompiling) foot.replaceChildren(el('span', { class: 'spin' }), 'Compiling…')
  else if (s.build?.isOk) foot.replaceChildren(`Compiled ${new Date(s.build.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${pageCount ? ` · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : ''}`)
  else if (s.pdf) foot.replaceChildren(`${s.pdf.path}${pageCount ? ` · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : ''}`)
  else foot.replaceChildren()
}

/** `main.tex:54` as a link to that line in Source. */
function at(where: string) {
  const m = /^(.*):(\d+)$/.exec(where)
  if (!m) return el('code', {}, where)
  return el('button', { class: 'jump', title: 'Show in Source', onclick: () => void goTo(m[1]!, Number(m[2])) }, el('code', {}, where))
}

function select(t: Tab) {
  tab = t
  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) b.setAttribute('aria-checked', String(b.dataset.tab === t))
  for (const id of ['pdf', 'source', 'changes'] as const) $(id).hidden = t !== id
  if (t === 'pdf') void renderPdf()
  if (t === 'source' && state) void syncSource(state)
}

// ---- Source ----

const editor = createEditor($('editor'), () => setDirty(true), () => void save())
let open_: { file: string; mtime: number } | null = null
let dirty = false

function note(text: string, isWarn = false) {
  $('note').textContent = text
  $('note').className = isWarn ? 'note warn' : 'note'
}

function setDirty(d: boolean) {
  dirty = d
  ;($('save') as HTMLButtonElement).disabled = !d
  if (d) note('Edited')
}

async function load(file: string) {
  if (!folder) return
  const r = await call<{ file: string; text: string; mtime: number }>('load_file', { folder, file })
  if (!r) return
  editor.load(r.text)
  open_ = { file: r.file, mtime: r.mtime }
  setDirty(false)
  $('reload').hidden = true
  ;($('file') as HTMLSelectElement).value = r.file
  if (state) syncSource(state)
}

/** Keep Source in step with the disk: the file list, a reload when Claude or Undo changed the open file, and a lock while it has changes to review. */
function syncSource(s: State) {
  const pick = $('file') as HTMLSelectElement
  if (pick.options.length !== s.files.length || [...pick.options].some((o, i) => o.value !== s.files[i])) {
    pick.replaceChildren(...s.files.map((f) => el('option', { value: f, textContent: f })))
  }
  if (!open_) {
    if (s.main) void load(s.main)
    return
  }
  pick.value = open_.file
  const disk = s.mtimes[open_.file]
  if (disk !== undefined && disk !== open_.mtime) {
    if (!dirty) return void load(open_.file)
    note('Claude changed this file. Reload to see it; your edit here would be lost.', true)
    $('reload').hidden = false
  }
  const pending = s.changes.some((c) => c.file === open_!.file)
  editor.lock(pending)
  if (pending) note('Claude’s changes to this file are waiting in Changes. Keep or undo them to edit here.', true)
  else if (!dirty && $('reload').hidden) note('')
}

async function save() {
  if (!folder || !open_ || !dirty) return
  try {
    const r = await call<{ file: string; mtime: number }>('save_file', { folder, file: open_.file, text: editor.text(), mtime: open_.mtime })
    if (!r) return
    open_ = { file: r.file, mtime: r.mtime }
    setDirty(false)
    note('Saved')
    await app.updateModelContext({ content: [{ type: 'text', text: `The author edited ${r.file} in the Dabir panel. Read ${r.file} again before editing it.` }] }).catch(() => {})
    await refresh()
  } catch (e) {
    note((e as Error).message, true)
  }
}

async function goTo(file: string, line: number) {
  select('source')
  if (open_?.file !== file) await load(file)
  editor.goTo(line)
}

$('save').addEventListener('click', () => void save())
$('reload').addEventListener('click', () => open_ && void load(open_.file))
$('file').addEventListener('change', (e) => {
  const file = (e.target as HTMLSelectElement).value
  if (dirty) {
    ;(e.target as HTMLSelectElement).value = open_!.file
    return note(`Save your edit to ${open_!.file} first.`, true)
  }
  void load(file)
})

// ---- The PDF ----

let doc: pdfjs.PDFDocumentProxy | null = null
let pageCount = 0
let renderedWidth = 0

async function loadPdf(dir: string, mtime: number) {
  shownPdf = mtime
  try {
    const parts: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const r = await call<{ bytes: string; total: number; hasMore: boolean }>('read_pdf', { folder: dir, offset, mtime })
      if (!r) return
      const bin = atob(r.bytes)
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
      parts.push(bytes)
      offset += bytes.length
      if (!r.hasMore) break
    }
    const data = new Uint8Array(offset)
    let at = 0
    for (const p of parts) { data.set(p, at); at += p.length }
    const next = await pdfjs.getDocument({ data }).promise
    await doc?.destroy()
    doc = next
    pageCount = doc.numPages
    renderedWidth = 0
    if (state) drawFoot(state)
    await renderPdf()
  } catch {
    shownPdf = 0 // the PDF changed while it was read; the next look reads it again
  }
}

/** Draw every page at the pane's width, off screen, then swap them in so the scroll position holds. */
async function renderPdf() {
  const pane = $('pdf')
  const width = Math.min(pane.clientWidth - 24, 900)
  if (!doc || pane.hidden || width <= 0 || width === renderedWidth) return
  renderedWidth = width
  const ratio = window.devicePixelRatio || 1
  const canvases: HTMLCanvasElement[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const base = page.getViewport({ scale: 1 })
    const vp = page.getViewport({ scale: (width / base.width) * ratio })
    const canvas = el('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height) })
    canvas.setAttribute('aria-label', `Page ${i}`)
    await page.render({ canvas, viewport: vp }).promise
    canvases.push(canvas)
  }
  const top = pane.scrollTop
  pane.replaceChildren(...canvases)
  pane.scrollTop = top
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined
new ResizeObserver(() => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => void renderPdf(), 150)
}).observe($('pdf'))

// ---- Talking to the server ----

async function refresh() {
  if (!folder || polling) return
  polling = true
  try {
    const s = await call<State>('paper_state', { folder })
    if (s) draw(s)
  } catch (e) {
    $('path').textContent = (e as Error).message
  } finally {
    polling = false
  }
}

async function review(file: string, keep: string[], undo: string[]) {
  if (!folder) return
  try {
    const s = await call<State>('review_changes', { folder, file, keep, undo })
    if (s) draw(s)
    if (undo.length) {
      await app.updateModelContext({ content: [{ type: 'text', text: `In the Dabir panel the author undid ${undo.length} ${undo.length === 1 ? 'change' : 'changes'} to ${file}. Read ${file} again before editing it.` }] }).catch(() => {})
    }
  } catch {
    await refresh()
  }
}

$('compile').addEventListener('click', async () => {
  if (!folder) return
  ;($('compile') as HTMLButtonElement).disabled = true
  $('foot').replaceChildren(el('span', { class: 'spin' }), 'Compiling…')
  try {
    await app.callServerTool({ name: 'compile_paper', arguments: { folder } })
  } finally {
    await refresh()
  }
})

for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) b.addEventListener('click', () => select(b.dataset.tab as Tab))
$('expand').addEventListener('click', () => void app.requestDisplayMode({ mode: 'fullscreen' }))

function layout(ctx: McpUiHostContext | undefined) {
  if (!ctx) return
  if (ctx.theme) applyDocumentTheme(ctx.theme)
  const inline = ctx.displayMode !== 'fullscreen'
  const panel = document.querySelector<HTMLElement>('.panel')!
  panel.classList.toggle('inline', inline)
  const dims = ctx.containerDimensions as { maxHeight?: number } | undefined
  panel.style.setProperty('--inline-h', `${Math.min(dims?.maxHeight ?? 560, 560)}px`)
  $('expand').hidden = !inline || !ctx.availableDisplayModes?.includes('fullscreen')
  const inset = ctx.safeAreaInsets
  if (inset) panel.style.padding = `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`
}

function open(dir: unknown) {
  if (typeof dir !== 'string' || dir === folder) return
  folder = dir
  void refresh()
}

app.ontoolinput = (p) => open(p.arguments?.folder)
app.ontoolresult = (r) => open((r.structuredContent as { folder?: string } | undefined)?.folder)
app.onhostcontextchanged = (ctx) => layout({ ...app.getHostContext(), ...ctx })
app.onteardown = async () => {
  folder = null
  return {}
}

await app.connect()
layout(app.getHostContext())
setInterval(() => {
  if (document.visibilityState === 'visible') void refresh()
}, 1500)
