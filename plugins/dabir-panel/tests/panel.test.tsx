import { expect, test } from 'claude-code/testing'

import { parseCheck, reverse, toDiff } from '../hooks/register'

const PANE = {
  plugin: 'dabir-panel',
  component: 'Pane',
  requestId: 'dabir',
  props: {
    title: 'Dabir',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const REPORT = 'main.tex:53: error: `\\begin{itemize}` is never closed\nmain.tex:20: warning: `\\ref{x}` has no `\\label`\ndabir-check: 1 error, 1 warning.\n'

test('dabir-check output is read into errors and warnings', () => {
  const r = parseCheck(REPORT)
  expect(r.errors).toEqual([{ at: 'main.tex:53', message: '`\\begin{itemize}` is never closed' }])
  expect(r.warnings.length).toBe(1)
  expect(parseCheck('dabir-check: 0 errors, 0 warnings.').errors.length).toBe(0)
})

test('long context is cut to one shortened line each side, and the header follows it', () => {
  const long = ` ${'x'.repeat(100)}`
  const d = toDiff([{ oldStart: 10, oldLines: 5, newStart: 10, newLines: 6, lines: [' a', ' b', long, '+new', ' c', ' d'] }])
  expect(d.text).toBe(`@@ -12,2 +12,3 @@\n ${'x'.repeat(71)}…\n+new\n c`)
})

test('hunks become a unified diff the Code element accepts', () => {
  const d = toDiff([{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [' a', '-\tb', '+c', '+d\r'] }])
  expect(d.text).toBe('@@ -3,1 +3,2 @@\n a\n-  b\n+c\n+d')
  expect([d.added, d.removed]).toEqual([2, 1])
})

test('undo takes back exactly one edit, and refuses when the text moved on', () => {
  const edit = { tool: 'Edit' as const, oldText: 'teh', newText: 'the' }
  expect(reverse('in the end', edit)).toBe('in teh end')
  expect(reverse('the cat and the dog', edit)).toBe(null)
  expect(reverse('nothing here', edit)).toBe(null)
  const write = { tool: 'Write' as const, oldText: 'before', newText: 'after' }
  expect(reverse('after', write)).toBe('before')
  expect(reverse('after, edited', write)).toBe(null)
})

test('a paper session: the panel opens, shows the error, records an edit and undoes it', async ($, on) => {
  const files: Record<string, string> = { '/paper/main.tex': '\\documentclass{article}\nin the end\n', '/paper/main.pdf': '%PDF' }
  const prompts: string[] = []
  on('tool.list', () => ({ value: [{ name: 'SendUserFile' }] }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { drop: 'recorded by the test' }
  })
  const written: string[] = []
  let opened = 0
  on('clock.now', () => ({ value: 1_000 }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'dabir-panel' } }))
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.cwd', () => ({ value: '/paper' }))
  on('session.root', () => ({ value: '/paper' }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.list', () => ({ value: [{ name: 'main.tex', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    written.push(e.path)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: REPORT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', { tool: 'Edit' }, () => ({
    result: {
      filePath: '/paper/main.tex',
      oldString: 'in the end',
      newString: 'in the beginning',
      originalFile: null,
      structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-in the end', '+in the beginning'] }],
      userModified: false,
      replaceAll: false,
    },
  }))

  await $.session.start({ cwd: '/paper', surface: 'desktop', isInteractive: true })
  files['/paper/main.tex'] = '\\documentclass{article}\nin the beginning\n'
  await $.tool.call({ tool: 'Edit', file_path: '/paper/main.tex', old_string: 'in the end', new_string: 'in the beginning' })
  expect(opened > 0).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 error/ }))?.text).toContain('1 error')
    expect((await ui.find({ type: 'Text', text: /never closed/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Changes this session \(1\)/ })) !== undefined).toBe(true)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const undo = await ui.find({ type: 'Button', text: /^Undo$/ })
  expect(undo !== undefined).toBe(true)
  await ui.press({ plugin: 'dabir-panel', key: undo!.key! })
  expect(toasts).toEqual([])
  expect(files['/paper/main.tex']).toBe('\\documentclass{article}\nin the end\n')
  expect(written).toEqual(['/paper/main.tex'])
  expect((await ui.find({ type: 'Text', text: /Changes this session/ }))?.text).toBe('Changes this session')
  const show = await ui.find({ type: 'Button', text: /^Show PDF$/ })
  await ui.press({ plugin: 'dabir-panel', key: show!.key! })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('/paper/main.pdf')
  await ui.unmount()
})
