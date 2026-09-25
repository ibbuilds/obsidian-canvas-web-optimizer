import type DiagnosticsMetrics from './metrics'

export type LocalBrowserDiagnostics = {
  available: boolean
  poolSize: number
  status: string
  unavailableReason: string
  hardwareSummary: string
  concurrencySummary: string
  tuningStatus: string
  activeTasks: number
  renderFailures: number
  launches: number
  closes: number
  launchFailures: number
  averageLaunchMs: number
  averageRenderMs: number
  averageSetupMs: number
  averageNavigationMs: number
  readinessProbeWins: number
  averagePaintReadyMs: number
  averageScreenshotMs: number
  screenshotOptimizationStatus: string
  lastFailureSummary: string
}

export type NetworkDiagnostics = {
  preconnectActive: boolean
  preconnectCount: number
  warmActive: boolean
  warmCompleted: number
  warmStarted: number
  warmFailed: number
}

export type DiagnosticsReportContext = {
  mountedWebCards: number
  cachedPreviews: number
  liveWebviews: number
  generatingThumbnails: number
  queued: number
  interactiveWebviewActive: boolean
  interactiveLightPreferenceStatus: string
  interactiveMatchMediaLight: boolean | null
  backgroundExecutionActive: boolean
  generationPreloadDisabled: boolean
  metrics: DiagnosticsMetrics
  localBrowser: LocalBrowserDiagnostics
  network: NetworkDiagnostics
}

export function formatDiagnosticsReport(context: DiagnosticsReportContext): string {
  const summary = context.metrics.summary()
  const local = context.localBrowser
  const network = context.network
  const generationEngine = local.available
    ? `local browser sidecar (${local.poolSize} workers)`
    : 'native webview'

  return [
    `Mounted web cards: ${context.mountedWebCards}`,
    `Cached previews: ${context.cachedPreviews}`,
    `Live webviews: ${context.liveWebviews}`,
    `Generating thumbnails: ${context.generatingThumbnails}`,
    `Queued: ${context.queued}`,
    `Generation engine: ${generationEngine}`,
    `Local browser: ${local.status}`,
    `Local browser unavailable reason: ${local.unavailableReason}`,
    `Local browser hardware: ${local.hardwareSummary}`,
    `Local browser concurrency: ${local.concurrencySummary}`,
    `Local browser tuning: ${local.tuningStatus}`,
    `Local browser active tasks: ${local.activeTasks}`,
    `Interactive webview: ${context.interactiveWebviewActive ? 1 : 0}`,
    `Interactive light preference: ${context.interactiveLightPreferenceStatus}`,
    `Interactive matchMedia light: ${
      context.interactiveMatchMediaLight === null
        ? 'not tested'
        : context.interactiveMatchMediaLight
    }`,
    `Background execution: ${context.backgroundExecutionActive ? 'on' : 'off'}`,
    `Network preconnect: ${
      local.available
        ? 'standby (local browser preferred)'
        : network.preconnectActive
          ? 'on'
          : 'off'
    } (${network.preconnectCount})`,
    `HTTP warm cache: ${
      local.available ? 'standby (local browser preferred)' : network.warmActive ? 'on' : 'off'
    } (${network.warmCompleted}/${network.warmStarted}, failed ${network.warmFailed})`,
    `Cache hits: ${context.metrics.cacheHits}`,
    `Cache misses: ${context.metrics.cacheMisses}`,
    `Generated: ${context.metrics.generationCompleted}`,
    `Generation failures: ${context.metrics.generationFailed}`,
    `Generation timeouts: ${context.metrics.generationTimedOut}`,
    `Generation preemptions: ${context.metrics.generationPreemptions}`,
    `Local browser fallbacks/timeouts: ${context.metrics.localFallbacks}/${context.metrics.localTimeouts}`,
    `Local browser render failures: ${local.renderFailures}`,
    `Local browser last render failure: ${local.lastFailureSummary}`,
    `Local browser launches/closes/launch failures: ${local.launches}/${local.closes}/${local.launchFailures}`,
    `Local browser screenshot mode: ${local.screenshotOptimizationStatus}`,
    `Local browser average launch: ${local.averageLaunchMs} ms`,
    `Local browser average render: ${local.averageRenderMs} ms`,
    `Local browser average setup: ${local.averageSetupMs} ms`,
    `Local browser average navigation: ${local.averageNavigationMs} ms`,
    `Local browser readiness probe wins: ${local.readinessProbeWins}`,
    `Local browser average paint ready: ${local.averagePaintReadyMs} ms`,
    `Local browser average screenshot: ${local.averageScreenshotMs} ms`,
    `Average local generation: ${summary.averageLocalGenerationMs} ms`,
    `Generation preload: ${context.generationPreloadDisabled ? 'disabled' : 'enabled'}`,
    `Preloads started/ready/hit/failed: ${context.metrics.generationPreloadsStarted}/${context.metrics.generationPreloadsReady}/${context.metrics.generationPreloadHits}/${context.metrics.generationPreloadFailures}`,
    `Preload immediate/pending hits: ${context.metrics.preloadImmediateHits}/${context.metrics.preloadPendingHits}`,
    `Average preload ready: ${summary.averagePreloadReadyMs} ms`,
    `Average preload promotion wait: ${summary.averagePromotionWaitMs} ms`,
    `Average cold generation: ${summary.averageColdGenerationMs} ms`,
    `Average preloaded generation: ${summary.averagePreloadedGenerationMs} ms`,
    `Last batch: ${context.metrics.lastBatchCompleted} cards / ${Math.round(
      context.metrics.lastBatchDurationMs
    )} ms`,
    `Last batch throughput: ${summary.lastBatchThroughput.toFixed(2)} cards/s`,
    `Average queue wait: ${summary.averageQueueWaitMs} ms`,
    `Average frame create: ${summary.averageFrameCreateMs} ms`,
    `Average DOM ready: ${summary.averageDomReadyMs} ms`,
    `Average theme apply: ${summary.averageThemeMs} ms`,
    `Average paint ready: ${summary.averagePaintReadyMs} ms`,
    `Average capturePage: ${summary.averageCapturePageMs} ms`,
    `Average encode: ${summary.averageEncodeMs} ms`,
    `Average thumbnail write: ${summary.averageThumbnailWriteMs} ms`,
    `Average metadata write: ${summary.averageMetadataWriteMs} ms`,
    `Average preview ready: ${summary.averagePreviewReadyMs} ms`,
    `Average generation: ${summary.averageGenerationMs} ms`,
    `Average capture pipeline: ${summary.averageCaptureMs} ms`,
    `Thumbnail bytes written: ${context.metrics.capturedThumbnailBytes}`
  ].join('\n')
}
