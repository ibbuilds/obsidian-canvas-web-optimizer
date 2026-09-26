import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import DiagnosticsMetrics from '../src/diagnostics/metrics'
import { formatDiagnosticsReport } from '../src/diagnostics/report'

test('diagnostics report preserves core runtime lines', () => {
  const metrics = new DiagnosticsMetrics()

  metrics.cacheHits = 3
  metrics.generationCompleted = 12
  metrics.lastBatchCompleted = 12
  metrics.lastBatchDurationMs = 6000
  metrics.localFallbacks = 1

  const report = formatDiagnosticsReport({
    mountedWebCards: 12,
    cachedPreviews: 11,
    liveWebviews: 1,
    generatingThumbnails: 0,
    queued: 0,
    stagedPreviews: 4,
    previewRevealActive: true,
    interactiveWebviewActive: true,
    interactiveLightPreferenceStatus: 'CDP applied',
    interactiveMatchMediaLight: true,
    backgroundExecutionActive: false,
    generationPreloadDisabled: false,
    metrics,
    localBrowser: {
      available: true,
      poolSize: 5,
      status: 'Microsoft Edge / idle',
      unavailableReason: 'none',
      hardwareSummary: '16 logical CPUs / 31.9 GiB RAM',
      concurrencySummary: '5 active / 8 hardware cap / 8 heuristic',
      tuningStatus: 'saved best 5',
      activeTasks: 0,
      renderFailures: 0,
      launches: 1,
      closes: 1,
      launchFailures: 0,
      averageLaunchMs: 100,
      averageRenderMs: 700,
      averageSetupMs: 40,
      averageNavigationMs: 600,
      readinessProbeWins: 2,
      averagePaintReadyMs: 10,
      averageVisualSettleMs: 620,
      visualSettleMaxOuts: 1,
      visualSettleComplexPages: 4,
      loaderBypasses: 2,
      cookieCleanupActions: 3,
      averageScreenshotMs: 50,
      screenshotOptimizationStatus: 'optimizeForSpeed enabled',
      lastFailureSummary: 'screenshot: https://example.com — capture failed'
    },
    network: {
      preconnectActive: false,
      preconnectCount: 0,
      warmActive: false,
      warmCompleted: 0,
      warmStarted: 0,
      warmFailed: 0
    }
  })

  assert.match(report, /Mounted web cards: 12/)
  assert.match(report, /Generation engine: local browser sidecar \(5 workers\)/)
  assert.match(report, /Interactive matchMedia light: true/)
  assert.match(report, /Staged previews: 4/)
  assert.match(report, /Preview reveal: active/)
  assert.match(report, /Cache hits: 3/)
  assert.match(report, /Local browser screenshot mode: optimizeForSpeed enabled/)
  assert.match(report, /Local browser last render failure: screenshot:/)
  assert.match(report, /Local browser average setup: 40 ms/)
  assert.match(report, /Local browser readiness probe wins: 2/)
  assert.match(report, /Local browser average paint ready: 10 ms/)
  assert.match(report, /Local browser average visual settle: 620 ms/)
  assert.match(report, /Local browser complex settles: 4/)
  assert.match(report, /Local browser loader bypasses: 2/)
  assert.match(report, /Cookie cleanup actions: 3/)
  assert.match(report, /Last batch throughput: 2\.00 cards\/s/)
})
