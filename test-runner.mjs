import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import esbuild from 'esbuild'

const outdir = '.test-dist'
const testFiles = readdirSync('tests')
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => join('tests', name))

try {
  await esbuild.build({
    entryPoints: testFiles,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning'
  })

  const compiledTests = testFiles.map(path => {
    const name = path.split(/[\\/]/).at(-1)?.replace(/\.ts$/, '.mjs')

    if (!name) {
      throw new Error(`Unable to resolve compiled test path for ${path}`)
    }

    return join(outdir, name)
  })

  const result = spawnSync(process.execPath, ['--test', ...compiledTests], {
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  process.exitCode = result.status ?? 1
} finally {
  rmSync(outdir, { recursive: true, force: true })
}
