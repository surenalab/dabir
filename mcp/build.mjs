// Build the server into one file and the panel into one HTML page; with --mcpb, pack the Claude Desktop extension.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
const define = { __VERSION__: JSON.stringify(version) }
const dist = path.join(here, 'dist')
rmSync(dist, { recursive: true, force: true })

await build({
  entryPoints: [path.join(here, 'src/server.ts')],
  outfile: path.join(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'eof',
  define,
})

const view = await build({
  entryPoints: [path.join(here, 'src/view.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  define,
})
const css = readFileSync(path.join(here, '../src/styles/tokens.css'), 'utf8') + readFileSync(path.join(here, 'src/view.css'), 'utf8')
const js = view.outputFiles[0].text.replaceAll('</script', '<\\/script')
const html = readFileSync(path.join(here, 'src/view.html'), 'utf8').replace('/*CSS*/', () => css).replace('/*JS*/', () => js)
writeFileSync(path.join(dist, 'view.html'), html)
console.log(`dist/server.mjs, dist/view.html (${(html.length / 1024) | 0} KB)`)

if (process.argv.includes('--mcpb')) {
  // dabir-check for every platform goes in bin/: CI downloads them from the release; locally, check-cli/build.sh makes them.
  const bins = path.join(here, 'bin')
  const found = existsSync(bins) ? readdirSync(bins).filter((f) => f.startsWith('dabir-check-')) : []
  if (!found.length) console.warn('warning: no dabir-check binaries in mcp/bin; the extension will look for dabir-check on PATH')
  const stage = path.join(here, '.stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(path.join(stage, 'bin'), { recursive: true })
  cpSync(path.join(dist, 'server.mjs'), path.join(stage, 'server.mjs'))
  cpSync(path.join(dist, 'view.html'), path.join(stage, 'view.html'))
  for (const f of found) cpSync(path.join(bins, f), path.join(stage, 'bin', f))
  const manifest = JSON.parse(readFileSync(path.join(here, 'manifest.json'), 'utf8'))
  writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ ...manifest, version }, null, 2))
  cpSync(path.join(here, '../design/dabir-icon-1024.png'), path.join(stage, 'icon.png'))
  cpSync(path.join(here, '../LICENSE'), path.join(stage, 'LICENSE'))
  cpSync(path.join(here, '../THIRD-PARTY-NOTICES.md'), path.join(stage, 'THIRD-PARTY-NOTICES.md'))
  const out = path.join(dist, 'dabir.mcpb')
  execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', stage, out], { stdio: 'inherit' })
  rmSync(stage, { recursive: true, force: true })
}
