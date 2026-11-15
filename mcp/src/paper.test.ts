import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compileErrors, hunks, parseCheck, parseSynctex, pickMain, settle, toPdf, toSource } from './paper.ts'

const base = 'one\ntwo\nthree\nfour\nfive\n'
const now = 'one\nTWO\nthree\nfour\nfive\nsix\n'

test('each changed run is one hunk with a line of context each side', () => {
  const hs = hunks(base, now)
  assert.equal(hs.length, 2)
  assert.deepEqual(hs[0]!.lines, [
    { t: 'ctx', s: 'one' },
    { t: 'del', s: 'two' },
    { t: 'add', s: 'TWO' },
    { t: 'ctx', s: 'three' },
  ])
  assert.equal(hs[0]!.oldLine, 2)
  assert.deepEqual([hs[1]!.newLine, hs[1]!.added, hs[1]!.removed], [6, 1, 0])
  assert.deepEqual(hunks(base, base), [])
})

test('keep moves a change into the reviewed text, undo takes it out of the paper', () => {
  const [a, b] = hunks(base, now)
  const kept = settle(base, now, [a!.id], [b!.id])!
  assert.equal(kept.base, 'one\nTWO\nthree\nfour\nfive\n')
  assert.equal(kept.current, 'one\nTWO\nthree\nfour\nfive\n')
  const pending = settle(base, now, [], [a!.id])!
  assert.equal(pending.current, 'one\ntwo\nthree\nfour\nfive\nsix\n')
  assert.equal(hunks(pending.base, pending.current).length, 1)
  assert.equal(settle(base, now, ['gone'], []), null)
})

test('a file without a final newline survives a round trip', () => {
  const [h] = hunks('a\nb', 'a\nc')
  assert.deepEqual(settle('a\nb', 'a\nc', [], [h!.id]), { base: 'a\nb', current: 'a\nb' })
})

test('dabir-check output, the main file and compile errors', () => {
  const r = parseCheck('main.tex:53: error: `\\begin{itemize}` is never closed\nmain.tex:9: warning: no label\ndabir-check: 1 error, 1 warning.\n')
  assert.deepEqual(r.errors, [{ at: 'main.tex:53', message: '`\\begin{itemize}` is never closed' }])
  assert.equal(r.warnings.length, 1)
  assert.equal(pickMain('main = "paper.tex"\n', []), 'paper.tex')
  assert.equal(pickMain(null, [{ name: 'a.tex', text: 'x' }, { name: 'b.tex', text: '\\documentclass{article}' }]), 'b.tex')
  assert.equal(compileErrors('note: Running TeX ...\nerror: main.tex:12: Undefined control sequence\nwarning: x'), 'error: main.tex:12: Undefined control sequence')
})

test('SyncTeX maps a source line to its place on the page, and a place back to its line', () => {
  const sp = 65536
  const s = parseSynctex(['SyncTeX Version:1', 'Input:1:/p/./main.tex', 'Input:2:/p/./tables/t.tex', 'Unit:1', '{1', `h1,10:${72 * sp},${100 * sp}:0,0,0`, `h1,12:${72 * sp},${140 * sp}:0,0,0`, `h2,3:${72 * sp},${300 * sp}:0,0,0`, '}1', '{2', `h1,40:${72 * sp},${90 * sp}:0,0,0`, '}2'].join('\n'))
  assert.deepEqual(toPdf(s, 'main.tex', 11), { page: 1, x: 72, y: 140 })
  assert.deepEqual(toPdf(s, 'main.tex', 13), { page: 2, x: 72, y: 90 })
  assert.equal(toPdf(s, 'main.tex', 99), null)
  assert.deepEqual(toSource(s, 1, 80, 295), { file: '/p/./tables/t.tex', line: 3 })
  assert.deepEqual(toSource(s, 2, 0, 0), { file: '/p/./main.tex', line: 40 })
})
