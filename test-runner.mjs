import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import esbuild from 'esbuild'

const outdir = '.test-dist'

try {
  await esbuild.build({
    entryPoints: ['tests/core-utils.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning'
  })

  const result = spawnSync(process.execPath, ['--test', `${outdir}/core-utils.test.mjs`], {
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  process.exitCode = result.status ?? 1
} finally {
  rmSync(outdir, { recursive: true, force: true })
}
