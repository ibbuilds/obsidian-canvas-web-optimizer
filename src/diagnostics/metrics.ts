export default class DiagnosticsMetrics {
  cacheHits = 0
  cacheMisses = 0
  generationCompleted = 0
  generationFailed = 0
  generationTimedOut = 0
  generationPreemptions = 0
  generationPreloadsStarted = 0
  generationPreloadsReady = 0
  generationPreloadHits = 0
  generationPreloadFailures = 0
  generationPreloadReadyTotalMs = 0
  preloadPromotionWaitTotalMs = 0
  preloadPromotionWaitCount = 0
  preloadImmediateHits = 0
  preloadPendingHits = 0
  generationColdTotalMs = 0
  generationColdCount = 0
  generationPreloadedTotalMs = 0
  generationPreloadedCount = 0
  generationTotalMs = 0
  batchCompleted = 0
  lastBatchDurationMs = 0
  lastBatchCompleted = 0
  queueWaitTotalMs = 0
  queueWaitCount = 0
  frameCreateTotalMs = 0
  frameCreateCount = 0
  domReadyTotalMs = 0
  domReadyCount = 0
  themeTotalMs = 0
  themeCount = 0
  paintReadyTotalMs = 0
  paintReadyCount = 0
  captureTotalMs = 0
  capturePageTotalMs = 0
  capturePageCount = 0
  encodeTotalMs = 0
  encodeCount = 0
  thumbnailWriteTotalMs = 0
  thumbnailWriteCount = 0
  metadataWriteTotalMs = 0
  metadataWriteCount = 0
  previewReadyTotalMs = 0
  previewReadyCount = 0
  capturedThumbnailBytes = 0
  localGenerationTotalMs = 0
  localGenerationCount = 0
  localFallbacks = 0
  localTimeouts = 0
  batchStartedAt: number | null = null

  reset(batchStartedAt: number | null = null) {
    this.cacheHits = 0
    this.cacheMisses = 0
    this.generationCompleted = 0
    this.generationFailed = 0
    this.generationTimedOut = 0
    this.generationPreemptions = 0
    this.generationPreloadsStarted = 0
    this.generationPreloadsReady = 0
    this.generationPreloadHits = 0
    this.generationPreloadFailures = 0
    this.generationPreloadReadyTotalMs = 0
    this.preloadPromotionWaitTotalMs = 0
    this.preloadPromotionWaitCount = 0
    this.preloadImmediateHits = 0
    this.preloadPendingHits = 0
    this.generationColdTotalMs = 0
    this.generationColdCount = 0
    this.generationPreloadedTotalMs = 0
    this.generationPreloadedCount = 0
    this.generationTotalMs = 0
    this.batchCompleted = 0
    this.lastBatchDurationMs = 0
    this.lastBatchCompleted = 0
    this.queueWaitTotalMs = 0
    this.queueWaitCount = 0
    this.frameCreateTotalMs = 0
    this.frameCreateCount = 0
    this.domReadyTotalMs = 0
    this.domReadyCount = 0
    this.themeTotalMs = 0
    this.themeCount = 0
    this.paintReadyTotalMs = 0
    this.paintReadyCount = 0
    this.captureTotalMs = 0
    this.capturePageTotalMs = 0
    this.capturePageCount = 0
    this.encodeTotalMs = 0
    this.encodeCount = 0
    this.thumbnailWriteTotalMs = 0
    this.thumbnailWriteCount = 0
    this.metadataWriteTotalMs = 0
    this.metadataWriteCount = 0
    this.previewReadyTotalMs = 0
    this.previewReadyCount = 0
    this.capturedThumbnailBytes = 0
    this.localGenerationTotalMs = 0
    this.localGenerationCount = 0
    this.localFallbacks = 0
    this.localTimeouts = 0
    this.batchStartedAt = batchStartedAt
  }
  summary() {
    const average = (total: number, count: number) => (count > 0 ? Math.round(total / count) : 0)
    const lastBatchSeconds = this.lastBatchDurationMs / 1000

    return {
      averageGenerationMs: average(this.generationTotalMs, this.generationCompleted),
      averageCaptureMs: average(this.captureTotalMs, this.generationCompleted),
      averagePreloadReadyMs: average(
        this.generationPreloadReadyTotalMs,
        this.generationPreloadsReady
      ),
      averagePromotionWaitMs: average(
        this.preloadPromotionWaitTotalMs,
        this.preloadPromotionWaitCount
      ),
      averageColdGenerationMs: average(this.generationColdTotalMs, this.generationColdCount),
      averagePreloadedGenerationMs: average(
        this.generationPreloadedTotalMs,
        this.generationPreloadedCount
      ),
      lastBatchThroughput:
        lastBatchSeconds > 0 ? this.lastBatchCompleted / lastBatchSeconds : 0,
      averageQueueWaitMs: average(this.queueWaitTotalMs, this.queueWaitCount),
      averageFrameCreateMs: average(this.frameCreateTotalMs, this.frameCreateCount),
      averageDomReadyMs: average(this.domReadyTotalMs, this.domReadyCount),
      averageThemeMs: average(this.themeTotalMs, this.themeCount),
      averagePaintReadyMs: average(this.paintReadyTotalMs, this.paintReadyCount),
      averageCapturePageMs: average(this.capturePageTotalMs, this.capturePageCount),
      averageEncodeMs: average(this.encodeTotalMs, this.encodeCount),
      averageThumbnailWriteMs: average(this.thumbnailWriteTotalMs, this.thumbnailWriteCount),
      averageMetadataWriteMs: average(this.metadataWriteTotalMs, this.metadataWriteCount),
      averagePreviewReadyMs: average(this.previewReadyTotalMs, this.previewReadyCount),
      averageLocalGenerationMs: average(
        this.localGenerationTotalMs,
        this.localGenerationCount
      )
    }
  }

}
