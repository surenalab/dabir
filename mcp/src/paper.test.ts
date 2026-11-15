import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compileErrors, hunks, parseCheck, pickMain, settle } from './paper.ts'

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
