// Drives the built server (dist/server.mjs) over stdio, as Claude Desktop does.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const here = path.dirname(fileURLToPath(import.meta.url))
const checkBin = path.join(here, '../../src-tauri/check-cli/target/release/dabir-check')
const hasCheck = existsSync(checkBin)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dabir-mcp-'))
const paper = path.join(tmp, 'paper')
// The test client says it draws MCP App panels, as Claude Desktop does; `plain` does not, as Claude Code.
const client = new Client({ name: 'test', version: '1' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } })
const plain = new Client({ name: 'plain', version: '1' })

type Line = { t: string }
// What the tools return, loosely: each test reads the fields it needs.
type Shape = { folder: string; file: string; text: string; mtime: number; changes: { file: string; hunks: { id: string; lines: Line[] }[] }[]; check: { errors: { message: string }[] }; bytes: string; total: number; hasMore: boolean }
type Out = { content: { type: string; text?: string }[]; structuredContent: Shape; isError?: boolean }
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: { folder: paper, ...args } })) as Out
const said = (r: Out) => r.content.map((c) => c.text ?? '').join('\n')

before(async () => {
  cpSync(path.join(here, '../../examples/score-anchor'), paper, { recursive: true })
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: tmp, XDG_CACHE_HOME: path.join(tmp, 'cache'), SHELL: '/bin/sh' }
  if (hasCheck) env.DABIR_CHECK = checkBin
  for (const c of [client, plain]) await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../dist/server.mjs')], env }))
})
after(async () => {
  await client.close()
  await plain.close()
})

test('the tools Claude sees, the ones only the panel sees, and the panel itself', async () => {
  const { tools } = await client.listTools()
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  assert.deepEqual(Object.keys(byName).sort(), ['check_paper', 'compile_paper', 'edit_paper', 'load_file', 'open_paper', 'paper_state', 'read_paper_file', 'read_pdf', 'review_changes', 'save_file'])
  type Meta = { ui: { resourceUri: string; visibility?: string[] } }
  assert.equal((byName.open_paper!._meta as Meta).ui.resourceUri, 'ui://dabir/panel.html')
  assert.deepEqual((byName.paper_state!._meta as Meta).ui.visibility, ['app'])
  const res = await client.readResource({ uri: 'ui://dabir/panel.html' })
  const view = res.contents[0] as { mimeType: string; text: string }
  assert.equal(view.mimeType, 'text/html;profile=mcp-app')
  assert.match(view.text, /--accent: #a8322d/)
})

test('open, edit, and the change waits for review', async () => {
  const opened = await call('open_paper', {})
  assert.match(said(opened), /Main file: main\.tex/)
  assert.equal(opened.structuredContent.folder, paper)
  const elsewhere = (await plain.callTool({ name: 'open_paper', arguments: { folder: paper } })) as Out
  assert.match(said(elsewhere), /does not show MCP App panels/)

  const edited = await call('edit_paper', { file: 'main.tex', old_text: 'We ask a narrow question', new_text: 'We ask one narrow question' })
  assert.match(said(edited), /Edited main\.tex/)
  if (hasCheck) assert.match(said(edited), /dabir-check: no errors/)

  const s = (await call('paper_state', {})).structuredContent
  assert.equal(s.changes.length, 1)
  assert.equal(s.changes[0]!.file, 'main.tex')
  assert.deepEqual(s.changes[0]!.hunks[0]!.lines.filter((l) => l.t !== 'ctx').map((l) => l.t), ['del', 'add'])
})

test('edits that should not happen are refused', async () => {
  assert.equal((await call('edit_paper', { file: 'main.tex', old_text: 'not in the paper', new_text: 'x' })).isError, true)
  assert.match(said(await call('edit_paper', { file: '../outside.tex', old_text: 'a', new_text: 'b' })), /outside the paper's folder/)
  assert.match(said(await call('read_paper_file', { file: 'figures/psnr-vs-noise.pdf' })), /not a LaTeX/)
  assert.match(said(await call('open_paper', { folder: tmp })), /not a paper's folder/)
})

test('undo puts the text back; keep makes it the reviewed text', async () => {
  let s = (await call('paper_state', {})).structuredContent
  s = (await call('review_changes', { file: 'main.tex', keep: [], undo: [s.changes[0]!.hunks[0]!.id] })).structuredContent
  assert.equal(s.changes.length, 0)
  assert.match(readFileSync(path.join(paper, 'main.tex'), 'utf8'), /We ask a narrow question/)

  await call('edit_paper', { file: 'main.tex', old_text: 'We ask a narrow question', new_text: 'We ask a sharper question' })
  s = (await call('paper_state', {})).structuredContent
  s = (await call('review_changes', { file: 'main.tex', keep: [s.changes[0]!.hunks[0]!.id], undo: [] })).structuredContent
  assert.equal(s.changes.length, 0)
  assert.match(readFileSync(path.join(paper, 'main.tex'), 'utf8'), /We ask a sharper question/)
  assert.equal((await call('review_changes', { file: 'main.tex', keep: ['stale'], undo: [] })).isError, true)
})

test('dabir-check errors reach Claude and the panel', { skip: !hasCheck && 'no dabir-check built' }, async () => {
  const r = await call('edit_paper', { file: 'main.tex', old_text: '\\end{document}', new_text: '\\begin{itemize}\n\\item draft\n\\end{document}' })
  assert.match(said(r), /dabir-check found errors/)
  const s = (await call('paper_state', {})).structuredContent
  assert.equal(s.check.errors.length, 1)
  assert.match(s.check.errors[0]!.message, /itemize/)
})

test('the PDF reaches the panel in pieces, and a PDF that changes mid-read is refused', async () => {
  const pdf = path.join(paper, 'main.pdf')
  writeFileSync(pdf, Buffer.alloc(700 * 1024, 7))
  const mtime = statSync(pdf).mtimeMs
  const a = (await call('read_pdf', { offset: 0, mtime })).structuredContent
  assert.deepEqual([a.total, a.hasMore, Buffer.from(a.bytes, 'base64').length], [700 * 1024, true, 512 * 1024])
  const b = (await call('read_pdf', { offset: 512 * 1024, mtime })).structuredContent
  assert.equal(b.hasMore, false)
  assert.equal((await call('read_pdf', { offset: 0, mtime: mtime - 1 })).isError, true)
})

test('the author edits in Source; a stale or under-review file is not written over', async () => {
  for (const c of (await call('paper_state', {})).structuredContent.changes) await call('review_changes', { file: c.file, keep: [], undo: c.hunks.map((h) => h.id) })
  const f = (await call('load_file', { file: 'main.tex' })).structuredContent
  const mine = f.text.replace('We ask a', 'We ask, plainly, a')
  assert.equal((await call('save_file', { file: 'main.tex', text: mine, mtime: f.mtime - 1 })).isError, true)
  const saved = await call('save_file', { file: 'main.tex', text: mine, mtime: f.mtime })
  assert.match(said(saved), /Saved main\.tex/)
  assert.equal(readFileSync(path.join(paper, 'main.tex'), 'utf8'), mine)
  assert.equal((await call('paper_state', {})).structuredContent.changes.length, 0, 'the author\'s own edit is not a change to review')

  await call('edit_paper', { file: 'main.tex', old_text: 'We ask, plainly, a', new_text: 'We ask a' })
  const again = (await call('load_file', { file: 'main.tex' })).structuredContent
  assert.match(said(await call('save_file', { file: 'main.tex', text: again.text + '%', mtime: again.mtime })), /Keep or undo/)
})
