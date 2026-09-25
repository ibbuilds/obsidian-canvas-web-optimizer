import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import esbuild from 'esbuild'

const outdir = '.test-dist'

try {
  await esbuild.build({
    entryPoints: [
      'tests/core-utils.test.ts',
      'tests/preview-cache.test.ts',
      'tests/dynamic-priority-queue.test.ts',
      'tests/interactive-activation.test.ts',
      'tests/generation-coordinator.test.ts',
      'tests/concurrency-tuner.test.ts',
      'tests/link-node-patcher.test.ts'
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning'
  })

  const result = spawnSync(
    process.execPath,
    [
      '--test',
      `${outdir}/core-utils.test.mjs`,
      `${outdir}/preview-cache.test.mjs`,
      `${outdir}/dynamic-priority-queue.test.mjs`,
      `${outdir}/interactive-activation.test.mjs`,
      `${outdir}/generation-coordinator.test.mjs`,
      `${outdir}/concurrency-tuner.test.mjs`,
      `${outdir}/link-node-patcher.test.mjs`
    ],
    {
      stdio: 'inherit'
    }
  )

  if (result.error) {
    throw result.error
  }

  process.exitCode = result.status ?? 1
} finally {
  rmSync(outdir, { recursive: true, force: true })
}
