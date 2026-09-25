import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
    logLevel: 'warning'
  })

  const result = spawnSync(process.execPath, ['--test', `${outdir}/core-utils.test.js`], {
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  process.exitCode = result.status ?? 1
} finally {
  rmSync(outdir, { recursive: true, force: true })
}
