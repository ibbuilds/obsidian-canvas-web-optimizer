import {
  type Canvas,
  type CanvasLeaf,
  type LinkNode,
  type LinkNodeConstructor,
  Notice,
  Plugin
} from 'obsidian'
import BackgroundExecutionController from './background-execution'
import PreviewCache, { CACHE_METADATA_VERSION, type CacheMetadata } from './cache/preview-cache'
import { type FrameMode, installLinkNodePatches } from './canvas/link-node-patcher'
import CanvasNodeRuntime, { type CanvasNodeState } from './canvas/node-runtime'
import {
  classifyViewportProximity,
  createRectBounds,
  createThumbnailCaptureGeometry,
  extractCanvasNodeIds,
  isFatalLoadFailure,
  type RectBounds,
  type ThumbnailCaptureGeometry
} from './core-utils'
import DiagnosticsMetrics from './diagnostics/metrics'
import { formatDiagnosticsReport } from './diagnostics/report'
import AdaptiveConcurrencyTuner, {
  type ConcurrencyTuningRecord
} from './generation/concurrency-tuner'
import GenerationCoordinator from './generation/coordinator'
import type {
  ActiveGeneration,
  DidFailLoadEvent,
  GenerationJob,
  GenerationOutcome,
  GenerationPreload,
  LocalBatchTuningSnapshot,
  LocalConcurrentGeneration
} from './generation/types'
import InteractiveActivationController from './interactive/activation-controller'
import { forceGuestLightPreference } from './interactive/webview-light'
import LocalBrowserRenderer, { type LocalBrowserRenderResult } from './local-browser-renderer'
import NetworkPreconnector from './network-preconnector'
import { openExternalUrl } from './platform/electron-runtime'
import { GENERATION_LIGHT_THEME_CSS, LIGHT_THEME_SCRIPT } from './web-theme'

const THUMBNAIL_JPEG_QUALITY = 76
const THUMBNAIL_MAX_LONG_EDGE = 896
const THUMBNAIL_MAX_VIEWPORT_LONG_EDGE = 4096

const PREVIEW_TRANSITION_FALLBACK_MS = 250
const PREVIEW_LOAD_TIMEOUT_MS = 1000
const PREVIEW_REVEAL_LEAD_IN_MS = 90
const PREVIEW_REVEAL_STAGGER_MS = 45
const INTERACTIVE_PAINT_SETTLE_MS = 50
const GENERATION_PAINT_TIMEOUT_MS = 120
const GENERATION_JOB_TIMEOUT_MS = 5000
const GENERATION_MAX_ATTEMPTS = 3
const GENERATION_RETRY_DELAY_MS = 150
const LOCAL_GENERATION_TIMEOUT_MS = 9500
const PRECONNECT_LOOKAHEAD_ORIGINS = 6
const HTTP_WARM_LOOKAHEAD_URLS = 2

const WEBVIEW_PAINT_READY_SCRIPT = `
  new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve)
    })
  })
`

type ThumbnailImage = {
  getSize(): { width: number; height: number }
  isEmpty(): boolean
  resize(options: { width: number; height: number; quality: 'good' }): ThumbnailImage
  toJPEG(quality: number): ArrayBuffer
}

type StagedPreview = {
  node: LinkNode
  preview: HTMLImageElement
}

type PluginData = {
  localRendererTuning?: Record<string, ConcurrencyTuningRecord>
  [key: string]: unknown
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function afterTransition(element: HTMLElement, callback: () => void) {
  let finished = false
  let timeoutId = 0

  const finish = () => {
    if (finished) return

    finished = true
    window.clearTimeout(timeoutId)
    callback()
  }

  element.addEventListener('transitionend', finish, {
    once: true
  })

  timeoutId = window.setTimeout(finish, PREVIEW_TRANSITION_FALLBACK_MS)
}

function waitForImage(image: HTMLImageElement): Promise<boolean> {
  if (image.complete) {
    return Promise.resolve(image.naturalWidth > 0)
  }

  return new Promise(resolve => {
    let settled = false

    const finish = (loaded: boolean) => {
      if (settled) return

      settled = true
      window.clearTimeout(timeoutId)
      image.removeEventListener('load', onLoad)
      image.removeEventListener('error', onError)
      resolve(loaded)
    }

    const onLoad = () => finish(image.naturalWidth > 0)
    const onError = () => finish(false)

    const timeoutId = window.setTimeout(() => finish(false), PREVIEW_LOAD_TIMEOUT_MS)

    image.addEventListener('load', onLoad, { once: true })
    image.addEventListener('error', onError, { once: true })
  })
}

export default class CanvasWebOptimizerPlugin extends Plugin {
  name = 'Canvas Web Optimizer'

  cacheDir = `${this.manifest.dir}/data/linkCache`

  private previewCache!: PreviewCache
  private readonly nodeRuntime = new CanvasNodeRuntime()

  private readonly generationCoordinator = new GenerationCoordinator<GenerationJob>({
    getKey: job => job.node.id,
    getPriority: job => this.getGenerationPriority(job.node),
    isValid: job => Boolean(job.node.nodeEl?.isConnected) && !this.getNodeState(job.node).cached,
    process: () => this.processThumbnailQueue()
  })
  private activeGeneration: ActiveGeneration | null = null
  private generationPreload: GenerationPreload | null = null
  private generationPreloadDisabled = false
  private readonly backgroundExecution = new BackgroundExecutionController()
  private backgroundExecutionRelease: (() => void) | null = null
  private networkPreconnector: NetworkPreconnector | null = null
  private localBrowserRenderer: LocalBrowserRenderer | null = null
  private readonly localGenerations = new Map<string, LocalConcurrentGeneration>()
  private pluginData: PluginData = {}
  private localBatchTuning: LocalBatchTuningSnapshot | null = null
  private concurrencyTuner: AdaptiveConcurrencyTuner | null = null
  private canvasUtilitiesBatchDepth = 0
  private readonly stagedPreviews = new Map<string, StagedPreview>()
  private readonly pendingPreviewPresentation = new Set<string>()
  private previewRevealPromise: Promise<void> | null = null

  private readonly interactiveActivation = new InteractiveActivationController<LinkNode>({
    isAvailable: node => this.isNodeContentMounted(node),
    prepare: node => {
      this.cancelGenerationPreload(true)
      this.abortLocalGenerations(true)
      this.abortActiveGeneration(true)
      this.discardStagedPreview(node)
      this.releaseBackgroundExecution()
      this.removePendingPlaceholder(node)
    },
    activate: node => {
      this.setInteractiveClasses(node, true)
      this.requestNodeFrame(node, 'interactive')
    },
    deactivate: node => this.deactivateInteractive(node)
  })
  private interactiveLightPreferenceStatus = 'not attempted'
  private interactiveMatchMediaLight: boolean | null = null

  private get activeInteractiveNode(): LinkNode | null {
    return this.interactiveActivation.activeNode
  }

  private readonly metrics = new DiagnosticsMetrics()

  async onload() {
    this.addCommand({
      id: 'cleanup-unused-thumbnails',
      name: 'Cleanup unused thumbnails',
      callback: () => this.cleanupThumbnails()
    })

    this.addCommand({
      id: 'show-diagnostics',
      name: 'Show diagnostics',
      callback: () => this.showDiagnostics()
    })

    this.addCommand({
      id: 'reset-diagnostics',
      name: 'Reset diagnostics',
      callback: () => this.resetDiagnostics()
    })

    this.registerEvent(
      this.app.workspace.on(`${this.manifest.id}:patched-canvas`, () => {
        this.reloadActiveCanvasViews()
      })
    )

    this.registerEvent(
      this.app.workspace.on('canvas-utilities:batch-start', () => {
        this.beginCanvasUtilitiesBatch()
      })
    )

    this.registerEvent(
      this.app.workspace.on('canvas-utilities:batch-end', () => {
        this.endCanvasUtilitiesBatch()
      })
    )

    this.registerEvent(
      this.app.workspace.on('canvas-utilities:geometry-changed', (canvas, detail) => {
        this.handleCanvasUtilitiesGeometryChanged(canvas, detail)
      })
    )

    this.previewCache = new PreviewCache(this.app, this.cacheDir, (message, debug) =>
      this.log(message, debug)
    )
    await this.previewCache.initialize()

    const loadedData = await this.loadData()

    this.pluginData = loadedData && typeof loadedData === 'object' ? (loadedData as PluginData) : {}

    this.networkPreconnector = new NetworkPreconnector(this.getWebviewPartition())
    this.localBrowserRenderer = new LocalBrowserRenderer()

    this.concurrencyTuner = new AdaptiveConcurrencyTuner(this.localBrowserRenderer)
    this.concurrencyTuner.initialize(
      this.pluginData.localRendererTuning?.[this.localBrowserRenderer.tuningKey]
    )

    this.app.workspace.onLayoutReady(() => {
      if (this.tryPatchLinkNode()) return

      const evt = this.app.workspace.on('layout-change', () => {
        if (!this.tryPatchLinkNode()) return

        this.app.workspace.offref(evt)
      })

      this.registerEvent(evt)
    })

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.pruneDetachedActiveResources()
        this.scheduleThumbnailQueue()
      })
    )

    this.log('Plugin loaded')
  }

  onunload() {
    this.log('Unloading plugin')

    this.canvasUtilitiesBatchDepth = 0
    this.stagedPreviews.clear()
    this.pendingPreviewPresentation.clear()
    this.previewRevealPromise = null
    this.generationCoordinator.clear()
    this.interactiveActivation.cancelPending()
    this.abortActiveGeneration(false)
    this.cancelGenerationPreload(true)
    this.abortLocalGenerations(false)
    this.removeInteractiveFrameImmediately()
    this.releaseBackgroundExecution()
    this.backgroundExecution.dispose()
    this.localBrowserRenderer?.dispose()
    this.localBrowserRenderer = null
    this.concurrencyTuner = null
    this.networkPreconnector = null

    this.reloadActiveCanvasViews()
  }

  reloadActiveCanvasViews() {
    this.app.workspace.getLeavesOfType('canvas').forEach(leaf => {
      leaf.rebuildView()
    })
  }

  private beginCanvasUtilitiesBatch() {
    this.canvasUtilitiesBatchDepth++
    this.generationCoordinator.markPrioritiesDirty()
  }

  private endCanvasUtilitiesBatch() {
    if (this.canvasUtilitiesBatchDepth > 0) {
      this.canvasUtilitiesBatchDepth--
    }

    this.generationCoordinator.markPrioritiesDirty()

    if (this.canvasUtilitiesBatchDepth === 0) {
      this.scheduleThumbnailQueue()
    }
  }

  private handleCanvasUtilitiesGeometryChanged(
    canvas: Canvas,
    detail: { reason: string; nodeIds: string[] }
  ) {
    this.generationCoordinator.markPrioritiesDirty()

    if (this.canvasUtilitiesReasonChangesCardSize(detail.reason)) {
      for (const nodeId of detail.nodeIds) {
        const node = canvas.nodes?.get(nodeId)

        if (node) {
          this.invalidateThumbnailGeometry(node)
        }
      }
    }

    if (this.canvasUtilitiesBatchDepth === 0) {
      this.scheduleThumbnailQueue()
    }
  }

  private canvasUtilitiesReasonChangesCardSize(reason: string): boolean {
    return reason === 'layout:bento' || reason === 'match-size' || reason === 'size-preset'
  }

  private invalidateThumbnailGeometry(node: LinkNode) {
    this.discardStagedPreview(node)

    const state = this.getNodeState(node)
    const geometry = this.getThumbnailCaptureGeometry(node)

    if (
      state.cached &&
      state.metadata?.viewportWidth === geometry.viewportWidth &&
      state.metadata?.viewportHeight === geometry.viewportHeight
    ) {
      return
    }

    const preview = node._previewImageEl

    if (preview?.isConnected) {
      preview.remove()
    }

    node._previewImageEl = null
    state.evaluated = true
    state.cached = false
    state.metadata = null
    state.preparation = null
    this.previewCache.forget(node.id)
    this.removeQueuedGeneration(node)

    if (this.generationPreload?.node === node) {
      this.cancelGenerationPreload(true)
    }

    this.abortLocalGenerationForNode(node, 'stale', true)

    const session = this.activeGeneration

    if (session?.node === node) {
      session.requeue = true
      this.removeNodeFrame(node)
      session.finish('stale')
    }

    if (this.activeInteractiveNode === node) {
      return
    }

    this.ensurePendingPlaceholder(node)
    this.enqueueThumbnailGeneration(node, true)
  }

  private getWebviewPartition(): string | null {
    const app = this.app as typeof this.app & {
      appId?: string
      getWebviewPartition?: () => string
    }
    const partition = app.getWebviewPartition?.()

    if (partition) return partition
    if (app.appId) return `persist:vault-${app.appId}`

    return null
  }

  log(msg: unknown, debug = false) {
    if (debug) {
      console.debug(`[${this.name}]`, msg)
      return
    }

    console.log(`[${this.name}]`, msg)
  }

  private getNodeState(node: LinkNode): CanvasNodeState {
    return this.nodeRuntime.getState(node)
  }

  private isNodeContentMounted(node: LinkNode): boolean {
    if (!node.nodeEl?.isConnected) return false

    if (typeof node.isContentMounted === 'boolean') {
      return node.isContentMounted
    }

    return Boolean(node.contentEl?.isConnected)
  }

  private ensureNodeContentMounted(node: LinkNode): boolean {
    if (!node.nodeEl?.isConnected) return false

    if (this.isNodeContentMounted(node)) return true

    node.mountContent()

    return this.isNodeContentMounted(node)
  }

  private hasIndexedCache(node: LinkNode): boolean {
    return this.previewCache.has(node.id)
  }

  private getNodeCanvasBounds(node: LinkNode): RectBounds | null {
    return createRectBounds(node.x, node.y, node.width, node.height)
  }

  private getThumbnailCaptureGeometry(node: LinkNode): ThumbnailCaptureGeometry {
    return createThumbnailCaptureGeometry(
      node.width || node.contentEl?.clientWidth || 640,
      node.height || node.contentEl?.clientHeight || 360,
      THUMBNAIL_MAX_LONG_EDGE,
      THUMBNAIL_MAX_VIEWPORT_LONG_EDGE
    )
  }

  private isThumbnailViewportCurrent(
    node: LinkNode,
    viewportWidth: number,
    viewportHeight: number
  ): boolean {
    const geometry = this.getThumbnailCaptureGeometry(node)

    return geometry.viewportWidth === viewportWidth && geometry.viewportHeight === viewportHeight
  }

  private isNodeNearVisibleViewport(node: LinkNode): boolean {
    if (!node.nodeEl?.isConnected) return false

    const canvasBounds = this.getNodeCanvasBounds(node)
    const viewport = node.canvas?.getViewportBBox?.()

    if (canvasBounds && viewport) {
      return classifyViewportProximity(canvasBounds, viewport) === 0
    }

    const rect = node.nodeEl.getBoundingClientRect()
    const viewportRect = node.canvas?.wrapperEl?.getBoundingClientRect()

    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top)
    ) {
      return false
    }

    const fallbackViewport =
      viewportRect && viewportRect.width > 0 && viewportRect.height > 0
        ? viewportRect
        : {
            left: 0,
            top: 0,
            right: node.nodeEl.ownerDocument.defaultView?.innerWidth ?? 0,
            bottom: node.nodeEl.ownerDocument.defaultView?.innerHeight ?? 0
          }

    return (
      rect.right >= fallbackViewport.left &&
      rect.left <= fallbackViewport.right &&
      rect.bottom >= fallbackViewport.top &&
      rect.top <= fallbackViewport.bottom
    )
  }

  private rehydrateCachedNode(node: LinkNode, attempt = 0) {
    if (!this.hasIndexedCache(node) || attempt > 6) return

    if (!node.nodeEl?.isConnected) {
      window.setTimeout(() => this.rehydrateCachedNode(node, attempt + 1), 50)
      return
    }

    if (!this.isNodeNearVisibleViewport(node)) return

    if (!this.isNodeContentMounted(node)) {
      node.mountContent()

      if (!this.isNodeContentMounted(node)) {
        window.setTimeout(() => this.rehydrateCachedNode(node, attempt + 1), 50)
        return
      }
    }

    void this.prepareNode(node)
  }

  private prepareNode(node: LinkNode): Promise<void> {
    const state = this.getNodeState(node)

    if (state.evaluated) {
      this.applyPreparedNodeState(node, state)
      return Promise.resolve()
    }

    const cacheFilesExist = this.hasIndexedCache(node)

    if (!cacheFilesExist) {
      this.markNodeCacheMiss(node, state)
      return Promise.resolve()
    }

    if (!this.isNodeContentMounted(node)) {
      return Promise.resolve()
    }

    if (state.preparation) return state.preparation

    state.preparation = this.evaluateNodeCache(node, state).finally(() => {
      state.preparation = null
    })

    return state.preparation
  }

  private async evaluateNodeCache(node: LinkNode, state: CanvasNodeState) {
    try {
      const geometry = this.getThumbnailCaptureGeometry(node)
      const metadata = await this.previewCache.readValidMetadata(node.id, node.url, {
        width: geometry.viewportWidth,
        height: geometry.viewportHeight
      })

      if (!metadata) {
        this.markNodeCacheMiss(node, state)
        return
      }

      state.evaluated = true
      state.cached = true
      state.metadata = metadata
      this.metrics.cacheHits++

      node.updateNodeLabel(metadata.title)
      this.applyPreparedNodeState(node, state)
    } catch (error) {
      this.log(error, true)
      this.markNodeCacheMiss(node, state)
    }
  }

  private markNodeCacheMiss(node: LinkNode, state: CanvasNodeState) {
    state.evaluated = true
    state.cached = false
    state.metadata = null

    this.previewCache.forget(node.id)
    this.metrics.cacheMisses++

    this.applyPreparedNodeState(node, state)
  }

  private applyPreparedNodeState(node: LinkNode, state: CanvasNodeState) {
    if (state.cached) {
      if (this.pendingPreviewPresentation.has(node.id)) {
        this.ensurePendingPlaceholder(node)
        return
      }

      this.removePendingPlaceholder(node)

      if (this.isNodeContentMounted(node)) {
        this.ensurePreview(node)
      }

      return
    }

    this.ensurePendingPlaceholder(node)
    this.enqueueThumbnailGeneration(node)
  }

  private onNodeMounted(node: LinkNode) {
    void this.prepareNode(node)
  }

  private attachActivationHandler(node: LinkNode) {
    const state = this.getNodeState(node)

    if (state.activationHandlerAttached) return

    state.activationHandlerAttached = true

    node.nodeEl.addEventListener(
      'pointerdown',
      event => {
        const target = event.target as globalThis.Node | null

        if (
          event.button !== 0 ||
          !target ||
          !node.contentEl.contains(target) ||
          !this.isNodeContentMounted(node)
        ) {
          return
        }

        event.preventDefault()
        event.stopImmediatePropagation()

        this.requestInteractiveActivation(node)
      },
      true
    )

    node.nodeEl.addEventListener(
      'click',
      event => {
        const target = event.target as Element | null
        const label = target?.closest?.('.canvas-node-label')

        if (!label || !node.nodeEl.contains(label)) return

        event.preventDefault()
        event.stopImmediatePropagation()

        void openExternalUrl(node.url).catch(error => this.log(error, true))
      },
      true
    )
  }

  private ensurePendingPlaceholder(node: LinkNode) {
    if (!this.isNodeContentMounted(node)) return

    const current = this.nodeRuntime.getPlaceholder(node)

    if (current?.isConnected) return

    current?.remove()

    const placeholder = node.contentEl.doc.createElement('div')
    const hostname = node.contentEl.doc.createElement('div')
    const status = node.contentEl.doc.createElement('div')

    placeholder.classList.add('canvas-web-pending-preview')
    hostname.classList.add('canvas-web-pending-host')
    status.classList.add('canvas-web-pending-status')

    try {
      hostname.textContent = new URL(node.url).hostname.replace(/^www\./, '')
    } catch {
      hostname.textContent = node.url
    }

    status.textContent = 'Loading preview'

    placeholder.append(hostname, status)
    node.contentEl.append(placeholder)
    this.nodeRuntime.setPlaceholder(node, placeholder)
  }

  private removePendingPlaceholder(node: LinkNode) {
    const placeholder = this.nodeRuntime.getPlaceholder(node)

    if (placeholder?.isConnected) {
      placeholder.remove()
    }

    this.nodeRuntime.clearPlaceholder(node)
  }

  private setPendingStatus(node: LinkNode, message: string) {
    this.ensurePendingPlaceholder(node)

    const placeholder = this.nodeRuntime.getPlaceholder(node)
    const status = placeholder?.querySelector<HTMLElement>('.canvas-web-pending-status')

    if (status) {
      status.textContent = message
    }

    placeholder?.classList.toggle('canvas-web-preview-ready', message === 'Ready')
  }

  private getPreviewResourceUrl(node: LinkNode): string {
    const resourcePath = this.previewCache.resourcePath(node.id)
    const cacheVersion = this.getNodeState(node).metadata?.capturedAt

    if (!cacheVersion) return resourcePath

    const separator = resourcePath.includes('?') ? '&' : '?'
    return `${resourcePath}${separator}v=${cacheVersion}`
  }

  private createPreviewImage(
    node: LinkNode,
    enterHidden = false,
    handleErrors = true
  ): HTMLImageElement {
    const preview = node.contentEl.doc.createElement('img')

    preview.classList.add('link-thumbnail')

    if (enterHidden) {
      preview.classList.add('link-thumbnail-enter')
    }

    preview.alt = 'Webpage thumbnail'
    preview.decoding = 'async'
    preview.draggable = false
    preview.src = this.getPreviewResourceUrl(node)

    if (handleErrors) {
      preview.addEventListener(
        'error',
        () => {
          this.handlePreviewError(node, preview)
        },
        { once: true }
      )
    }

    return preview
  }

  private ensurePreview(
    node: LinkNode,
    force = false,
    enterHidden = false
  ): HTMLImageElement | null {
    this.removePendingPlaceholder(node)

    const current = node._previewImageEl

    if (current?.isConnected) {
      if (force) {
        current.classList.remove('link-thumbnail-exit')
      }

      current.classList.toggle('link-thumbnail-enter', enterHidden)
      return current
    }

    if (!this.isNodeContentMounted(node)) return null

    if (!force && this.activeInteractiveNode === node && node.frameEl?.isConnected) {
      return null
    }

    current?.remove()

    const preview = this.createPreviewImage(node, enterHidden)

    node.contentEl.append(preview)
    node._previewImageEl = preview

    return preview
  }

  private async stageGeneratedPreview(node: LinkNode): Promise<boolean> {
    this.pendingPreviewPresentation.add(node.id)
    this.setPendingStatus(node, 'Finalizing preview')

    const preview = this.createPreviewImage(node, true, false)
    const loaded = await waitForImage(preview)

    if (!loaded || !this.getNodeState(node).cached) {
      this.pendingPreviewPresentation.delete(node.id)

      if (!loaded) {
        const state = this.getNodeState(node)

        state.evaluated = true
        state.cached = false
        state.metadata = null
        await this.previewCache.remove(node.id)
      }

      return false
    }

    this.stagedPreviews.set(node.id, { node, preview })
    this.setPendingStatus(node, 'Ready')
    this.scheduleStagedPreviewReveal()

    return true
  }

  private discardStagedPreview(node: LinkNode) {
    this.stagedPreviews.delete(node.id)
    this.pendingPreviewPresentation.delete(node.id)
  }

  private scheduleStagedPreviewReveal() {
    if (this.previewRevealPromise || this.stagedPreviews.size === 0) return

    this.previewRevealPromise = (async () => {
      await delay(PREVIEW_REVEAL_LEAD_IN_MS)
      await this.revealStagedPreviews()
    })().finally(() => {
      this.previewRevealPromise = null

      if (this.stagedPreviews.size > 0) {
        this.scheduleStagedPreviewReveal()
      }
    })
  }

  private async revealStagedPreviews() {
    const staged = [...this.stagedPreviews.values()].sort((left, right) => {
      const vertical = (left.node.y ?? 0) - (right.node.y ?? 0)

      if (Math.abs(vertical) > 1) return vertical

      return (left.node.x ?? 0) - (right.node.x ?? 0)
    })

    for (const entry of staged) {
      const { node, preview } = entry

      if (this.stagedPreviews.get(node.id)?.preview !== preview) {
        continue
      }

      this.stagedPreviews.delete(node.id)

      const state = this.getNodeState(node)

      if (
        !state.cached ||
        !node.nodeEl?.isConnected ||
        !this.isNodeContentMounted(node) ||
        this.activeInteractiveNode === node
      ) {
        this.pendingPreviewPresentation.delete(node.id)
        continue
      }

      const current = node._previewImageEl

      if (current?.isConnected) {
        current.remove()
      }

      preview.addEventListener(
        'error',
        () => {
          this.handlePreviewError(node, preview)
        },
        { once: true }
      )

      this.removePendingPlaceholder(node)
      node.contentEl.append(preview)
      node._previewImageEl = preview
      this.pendingPreviewPresentation.delete(node.id)

      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            preview.classList.remove('link-thumbnail-enter')
            resolve()
          })
        })
      })

      await delay(PREVIEW_REVEAL_STAGGER_MS)
    }
  }

  private async showPreviewOverFrame(node: LinkNode, animate = true): Promise<boolean> {
    const preview = this.ensurePreview(node, true, animate)

    if (!preview) return false

    if (!animate && !node.nodeEl.ownerDocument.hasFocus()) {
      preview.classList.remove('link-thumbnail-enter', 'link-thumbnail-exit')
      return true
    }

    const loaded = await waitForImage(preview)

    if (!loaded || node._previewImageEl !== preview || !preview.isConnected) {
      return false
    }

    if (!animate) {
      preview.classList.remove('link-thumbnail-enter', 'link-thumbnail-exit')
      return true
    }

    await new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

    if (node._previewImageEl !== preview || !preview.isConnected) {
      return false
    }

    preview.classList.remove('link-thumbnail-enter')

    await new Promise<void>(resolve => {
      afterTransition(preview, resolve)
    })

    return node._previewImageEl === preview && preview.isConnected
  }

  private handlePreviewError(node: LinkNode, preview: HTMLImageElement) {
    this.discardStagedPreview(node)

    if (node._previewImageEl === preview) {
      preview.remove()
      node._previewImageEl = null
    }

    const state = this.getNodeState(node)
    state.evaluated = true
    state.cached = false
    state.metadata = null

    this.previewCache.forget(node.id)
    this.ensurePendingPlaceholder(node)

    if (this.activeGeneration?.node === node) {
      this.activeGeneration.requeue = true
      return
    }

    const localGeneration = this.localGenerations.get(node.id)

    if (localGeneration?.node === node) {
      localGeneration.requeue = true
      return
    }

    if (this.isNodeContentMounted(node)) {
      this.enqueueThumbnailGeneration(node)
    }
  }

  private enqueueThumbnailGeneration(
    node: LinkNode,
    front = false,
    attempt = 0,
    forceNative = false
  ) {
    const state = this.getNodeState(node)

    if (state.cached || !node.nodeEl?.isConnected) return

    if (
      this.activeGeneration?.node.id === node.id ||
      this.localGenerations.has(node.id) ||
      this.generationCoordinator.has(node.id)
    ) {
      return
    }

    if (
      this.metrics.batchStartedAt === null &&
      !this.activeGeneration &&
      this.localGenerations.size === 0 &&
      this.generationCoordinator.length === 0
    ) {
      this.metrics.batchStartedAt = performance.now()
      this.metrics.batchCompleted = 0

      const renderer = this.localBrowserRenderer

      this.localBatchTuning = renderer?.available
        ? {
            concurrency: renderer.poolSize,
            localGenerationCount: this.metrics.localGenerationCount,
            localFallbacks: this.metrics.localFallbacks,
            generationPreemptions: this.metrics.generationPreemptions
          }
        : null
    }

    const job: GenerationJob = {
      node,
      attempt,
      enqueuedAt: performance.now(),
      forceNative
    }

    this.generationCoordinator.enqueue(job, front)
    this.scheduleThumbnailQueue()
  }

  private scheduleThumbnailQueue() {
    this.pruneDetachedActiveResources()

    if (this.canvasUtilitiesBatchDepth > 0) {
      this.releaseBackgroundExecutionIfIdle()
      return
    }

    if (
      this.activeInteractiveNode ||
      this.generationCoordinator.isScheduled ||
      this.generationCoordinator.length === 0
    ) {
      this.releaseBackgroundExecutionIfIdle()
      return
    }

    const nextJob = this.generationCoordinator.peek()

    if (!nextJob) {
      this.releaseBackgroundExecutionIfIdle()
      return
    }

    this.ensureBackgroundExecution(nextJob.node)
    this.generationCoordinator.schedule()
  }

  private async processThumbnailQueue() {
    if (this.activeInteractiveNode || this.canvasUtilitiesBatchDepth > 0) return

    const renderer = this.localBrowserRenderer

    if (renderer?.available) {
      while (
        renderer.available &&
        !this.activeInteractiveNode &&
        this.localGenerations.size < renderer.poolSize
      ) {
        const localJob = this.dequeueNextGenerationJob(job => !job.forceNative)

        if (!localJob) break

        if (!this.ensureNodeContentMounted(localJob.node)) {
          this.generationCoordinator.enqueue(localJob, true)
          break
        }

        this.startLocalGeneration(localJob, renderer)
      }

      if (!this.activeGeneration) {
        const nativeFallbackJob = this.dequeueNextGenerationJob(job => job.forceNative)

        if (nativeFallbackJob) {
          if (!this.ensureNodeContentMounted(nativeFallbackJob.node)) {
            this.generationCoordinator.enqueue(nativeFallbackJob, true)
          } else {
            this.preconnectQueuedWork()
            this.warmQueuedWork()
            await this.generateQueuedThumbnail(nativeFallbackJob)

            if (!this.activeInteractiveNode) {
              this.scheduleThumbnailQueue()
            }
          }
        }
      }

      this.releaseBackgroundExecutionIfIdle()
      return
    }

    if (this.activeGeneration) return

    this.preconnectQueuedWork()

    const job = this.dequeueNextGenerationJob()

    if (!job) {
      this.releaseBackgroundExecutionIfIdle()
      return
    }

    if (!this.ensureNodeContentMounted(job.node)) {
      this.generationCoordinator.enqueue(job, true)
      return
    }

    this.warmQueuedWork()

    await this.generateQueuedThumbnail(job)

    if (!this.activeInteractiveNode) {
      this.scheduleThumbnailQueue()
    }
  }

  private preconnectQueuedWork() {
    if (!this.networkPreconnector || this.generationCoordinator.length === 0) return

    const urls = this.generationCoordinator.values().map(job => job.node.url)

    this.networkPreconnector.preconnect(urls, PRECONNECT_LOOKAHEAD_ORIGINS)
  }

  private warmQueuedWork() {
    if (!this.networkPreconnector || this.generationCoordinator.length === 0) return

    const urls = this.generationCoordinator.values().map(job => job.node.url)

    this.networkPreconnector.warm(urls, HTTP_WARM_LOOKAHEAD_URLS)
  }

  private peekNextGenerationJob(): GenerationJob | null {
    return this.generationCoordinator.peek()
  }

  private startNextGenerationPreload() {
    if (
      this.localBrowserRenderer?.available ||
      this.canvasUtilitiesBatchDepth > 0 ||
      this.generationPreloadDisabled ||
      this.generationPreload ||
      !this.activeGeneration ||
      this.activeInteractiveNode
    ) {
      return
    }

    const job = this.peekNextGenerationJob()

    if (!job || !this.ensureNodeContentMounted(job.node)) return

    let resolveReady: (ready: boolean) => void = () => {}
    const readyPromise = new Promise<boolean>(resolve => {
      resolveReady = resolve
    })
    const preload: GenerationPreload = {
      node: job.node,
      startedAt: performance.now(),
      frameEl: null,
      prepared: false,
      readyPromise,
      resolveReady,
      settled: false,
      cleanup: () => {}
    }

    this.generationPreload = preload
    this.metrics.generationPreloadsStarted++
    this.requestNodeFrame(job.node, 'preload')
  }

  private settleGenerationPreload(
    preload: GenerationPreload,
    ready: boolean,
    runtimeFailure = false
  ) {
    if (preload.settled) return

    preload.settled = true
    preload.cleanup()

    if (ready) {
      preload.readyAt = performance.now()
      this.metrics.generationPreloadsReady++
      this.metrics.generationPreloadReadyTotalMs += preload.readyAt - preload.startedAt
    } else {
      if (runtimeFailure) {
        this.metrics.generationPreloadFailures++
        this.generationPreloadDisabled = true
      }

      if (this.generationPreload === preload) {
        this.generationPreload = null
      }
    }

    preload.resolveReady(ready)
  }

  private cancelGenerationPreload(removeFrame: boolean) {
    const preload = this.generationPreload

    if (!preload) return

    this.generationPreload = null

    if (removeFrame && preload.frameEl && preload.node.frameEl === preload.frameEl) {
      this.removeNodeFrame(preload.node)
    }

    this.settleGenerationPreload(preload, false)
  }

  private dequeueNextGenerationJob(
    predicate: (job: GenerationJob) => boolean = () => true
  ): GenerationJob | null {
    const job = this.generationCoordinator.dequeue(predicate)

    if (!job) return null

    this.metrics.queueWaitTotalMs += performance.now() - job.enqueuedAt
    this.metrics.queueWaitCount++

    return job
  }

  private getGenerationPriority(node: LinkNode): number {
    const viewport = node.canvas?.getViewportBBox?.()
    const bounds = this.getNodeCanvasBounds(node)

    if (!viewport || !bounds) return 1

    return classifyViewportProximity(bounds, viewport)
  }

  private generateQueuedThumbnail(job: GenerationJob): Promise<void> {
    const { node } = job
    const geometry = this.getThumbnailCaptureGeometry(node)

    return new Promise(resolve => {
      let completed = false

      const session: ActiveGeneration = {
        node,
        url: node.url,
        startedAt: performance.now(),
        viewportWidth: geometry.viewportWidth,
        viewportHeight: geometry.viewportHeight,
        requeue: false,
        finish: () => {}
      }

      const timeoutId = window.setTimeout(() => {
        this.log(`Thumbnail generation timed out for ${session.url}`, true)

        this.removeNodeFrame(node)
        session.finish('timeout')
      }, GENERATION_JOB_TIMEOUT_MS)

      session.finish = outcome => {
        if (completed) return

        completed = true
        window.clearTimeout(timeoutId)

        if (this.activeGeneration === session) {
          this.activeGeneration = null
        }

        if (outcome === 'success') {
          const generationDuration = performance.now() - session.startedAt

          this.metrics.generationCompleted++
          this.metrics.batchCompleted++
          this.metrics.generationTotalMs += generationDuration

          if (session.usedPreload) {
            this.metrics.generationPreloadedTotalMs += generationDuration
            this.metrics.generationPreloadedCount++
          } else {
            this.metrics.generationColdTotalMs += generationDuration
            this.metrics.generationColdCount++
          }
        } else if (outcome === 'timeout') {
          this.metrics.generationTimedOut++
        } else if (outcome === 'failure') {
          this.metrics.generationFailed++
        } else if (outcome === 'preempted') {
          this.metrics.generationPreemptions++
        }

        if (session.usedPreload && (outcome === 'failure' || outcome === 'timeout')) {
          this.generationPreloadDisabled = true
          this.cancelGenerationPreload(true)
        }

        const canRetry =
          !this.getNodeState(node).cached &&
          Boolean(node.nodeEl?.isConnected) &&
          job.attempt + 1 < GENERATION_MAX_ATTEMPTS
        const shouldPriorityRequeue =
          (session.requeue || outcome === 'stale') &&
          !this.getNodeState(node).cached &&
          Boolean(node.nodeEl?.isConnected)
        const shouldRetryFailure = canRetry && (outcome === 'failure' || outcome === 'timeout')

        resolve()

        if (shouldPriorityRequeue) {
          this.enqueueThumbnailGeneration(node, true, job.attempt, job.forceNative)
        } else if (shouldRetryFailure) {
          this.setPendingStatus(
            node,
            `Retrying preview (${job.attempt + 2}/${GENERATION_MAX_ATTEMPTS})`
          )

          window.setTimeout(() => {
            this.enqueueThumbnailGeneration(node, true, job.attempt + 1, job.forceNative)
          }, GENERATION_RETRY_DELAY_MS)
        } else {
          if ((outcome === 'failure' || outcome === 'timeout') && !this.getNodeState(node).cached) {
            this.setPendingStatus(node, 'Click to load live')
          }

          this.releaseBackgroundExecutionIfIdle()
        }
      }

      const preload = this.generationPreload?.node === node ? this.generationPreload : null

      if (this.generationPreload && !preload) {
        this.cancelGenerationPreload(true)
      }

      if (preload) {
        this.generationPreload = null
      }

      this.activeGeneration = session

      if (preload) {
        session.usedPreload = true
        this.metrics.generationPreloadHits++

        const promotionWaitStartedAt = performance.now()

        if (preload.readyAt !== undefined) {
          this.metrics.preloadImmediateHits++
        } else {
          this.metrics.preloadPendingHits++
        }

        void preload.readyPromise.then(ready => {
          this.metrics.preloadPromotionWaitTotalMs += performance.now() - promotionWaitStartedAt
          this.metrics.preloadPromotionWaitCount++
          if (this.activeGeneration !== session) return

          const frameEl = preload.frameEl

          if (!ready || !frameEl || node.frameEl !== frameEl || !frameEl.isConnected) {
            session.finish('failure')
            return
          }

          session.preparedByPreload = preload.prepared
          void this.captureGeneratedFrame(node, frameEl)
        })
      } else {
        session.frameRequestedAt = performance.now()
        this.requestNodeFrame(node, 'generation')
      }

      this.startNextGenerationPreload()
    })
  }

  private startLocalGeneration(job: GenerationJob, renderer: LocalBrowserRenderer) {
    const { node } = job
    const geometry = this.getThumbnailCaptureGeometry(node)
    const task = renderer.render(
      node.url,
      geometry.viewportWidth,
      geometry.viewportHeight,
      geometry.captureScale
    )
    const generation: LocalConcurrentGeneration = {
      job,
      node,
      url: node.url,
      startedAt: performance.now(),
      viewportWidth: geometry.viewportWidth,
      viewportHeight: geometry.viewportHeight,
      captureScale: geometry.captureScale,
      task,
      requeue: false,
      completed: false,
      timeoutId: 0
    }

    this.localGenerations.set(node.id, generation)

    generation.timeoutId = window.setTimeout(() => {
      if (!this.isCurrentLocalGeneration(generation)) return

      this.metrics.localTimeouts++
      this.log(`Local browser render timed out for ${generation.url}; falling back to native`, true)
      this.finishLocalGeneration(generation, 'fallback')
    }, LOCAL_GENERATION_TIMEOUT_MS)

    void task.promise
      .then(result => {
        if (!this.isCurrentLocalGeneration(generation)) return

        void this.commitLocalThumbnail(node, generation, result)
      })
      .catch(error => {
        if (!this.isCurrentLocalGeneration(generation)) return

        this.log(`Local browser render failed for ${generation.url}: ${String(error)}`, true)
        this.finishLocalGeneration(generation, 'fallback')
      })
  }

  private isCurrentLocalGeneration(generation: LocalConcurrentGeneration): boolean {
    return !generation.completed && this.localGenerations.get(generation.node.id) === generation
  }

  private finishLocalGeneration(
    generation: LocalConcurrentGeneration,
    outcome: GenerationOutcome | 'fallback'
  ) {
    if (generation.completed) return

    generation.completed = true
    window.clearTimeout(generation.timeoutId)

    if (this.localGenerations.get(generation.node.id) === generation) {
      this.localGenerations.delete(generation.node.id)
    }

    if (outcome !== 'success') {
      generation.task.cancel()
    }

    const { job, node } = generation

    if (outcome === 'success') {
      const generationDuration = performance.now() - generation.startedAt

      this.metrics.generationCompleted++
      this.metrics.batchCompleted++
      this.metrics.generationTotalMs += generationDuration
      this.metrics.localGenerationTotalMs += generationDuration
      this.metrics.localGenerationCount++
    } else if (outcome === 'fallback') {
      this.metrics.localFallbacks++

      if (!this.getNodeState(node).cached && node.nodeEl?.isConnected) {
        this.enqueueThumbnailGeneration(node, true, job.attempt, true)
      }
    } else if (outcome === 'preempted') {
      this.metrics.generationPreemptions++
    }

    if (
      generation.requeue &&
      outcome !== 'fallback' &&
      !this.getNodeState(node).cached &&
      node.nodeEl?.isConnected
    ) {
      this.enqueueThumbnailGeneration(node, true, job.attempt)
    }

    if (!this.activeInteractiveNode) {
      this.scheduleThumbnailQueue()
    }

    this.releaseBackgroundExecutionIfIdle()
  }

  private abortLocalGenerations(requeue: boolean) {
    for (const generation of [...this.localGenerations.values()]) {
      generation.requeue = requeue
      this.finishLocalGeneration(generation, 'preempted')
    }
  }

  private abortLocalGenerationForNode(node: LinkNode, outcome: GenerationOutcome, requeue = false) {
    const generation = this.localGenerations.get(node.id)

    if (!generation || generation.node !== node) return

    generation.requeue = requeue
    this.finishLocalGeneration(generation, outcome)
  }

  private async commitLocalThumbnail(
    node: LinkNode,
    generation: LocalConcurrentGeneration,
    result: LocalBrowserRenderResult
  ) {
    if (!this.isCurrentLocalGeneration(generation)) return

    if (node.url !== generation.url) {
      this.finishLocalGeneration(generation, 'stale')
      return
    }

    if (
      !this.isThumbnailViewportCurrent(node, generation.viewportWidth, generation.viewportHeight)
    ) {
      generation.requeue = true
      this.finishLocalGeneration(generation, 'stale')
      return
    }

    const captureStartedAt = performance.now()

    try {
      const thumbnailWriteStartedAt = performance.now()
      await this.previewCache.writeThumbnail(node.id, result.jpeg)
      this.metrics.thumbnailWriteTotalMs += performance.now() - thumbnailWriteStartedAt
      this.metrics.thumbnailWriteCount++
      this.metrics.captureTotalMs += performance.now() - captureStartedAt
      this.metrics.capturedThumbnailBytes += result.jpeg.byteLength
    } catch (error) {
      this.log(error, true)
      this.finishLocalGeneration(generation, 'fallback')
      return
    }

    if (!this.isCurrentLocalGeneration(generation)) return

    if (node.url !== generation.url) {
      this.finishLocalGeneration(generation, 'stale')
      return
    }

    if (
      !this.isThumbnailViewportCurrent(node, generation.viewportWidth, generation.viewportHeight)
    ) {
      generation.requeue = true
      this.finishLocalGeneration(generation, 'stale')
      return
    }

    let title = result.title

    if (!title) {
      try {
        title = new URL(generation.url).hostname
      } catch {
        title = generation.url
      }
    }

    const metadata: CacheMetadata = {
      version: CACHE_METADATA_VERSION,
      url: generation.url,
      title,
      capturedAt: Date.now(),
      viewportWidth: generation.viewportWidth,
      viewportHeight: generation.viewportHeight
    }

    try {
      const metadataWriteStartedAt = performance.now()

      await this.previewCache.writeMetadata(node.id, metadata)

      this.metrics.metadataWriteTotalMs += performance.now() - metadataWriteStartedAt
      this.metrics.metadataWriteCount++
    } catch (error) {
      this.log(error, true)
      this.finishLocalGeneration(generation, 'fallback')
      return
    }

    const state = this.getNodeState(node)

    state.evaluated = true
    state.cached = true
    state.metadata = metadata

    node.updateNodeLabel(title)

    const previewStartedAt = performance.now()
    const previewReady = await this.stageGeneratedPreview(node)
    this.metrics.previewReadyTotalMs += performance.now() - previewStartedAt
    this.metrics.previewReadyCount++

    if (!this.isCurrentLocalGeneration(generation)) return

    if (!previewReady || !this.getNodeState(node).cached) {
      const failedState = this.getNodeState(node)

      failedState.evaluated = true
      failedState.cached = false
      failedState.metadata = null

      await this.previewCache.remove(node.id)

      this.finishLocalGeneration(generation, 'fallback')
      return
    }

    this.log(`Cached link ${node.url} with local browser renderer`)
    this.finishLocalGeneration(generation, 'success')
  }

  private ensureBackgroundExecution(node: LinkNode) {
    if (this.backgroundExecutionRelease) return

    this.backgroundExecutionRelease = this.backgroundExecution.acquire(
      node.nodeEl.ownerDocument.defaultView
    )
  }

  private releaseBackgroundExecution() {
    this.backgroundExecutionRelease?.()
    this.backgroundExecutionRelease = null
  }

  private releaseBackgroundExecutionIfIdle() {
    if (
      this.activeGeneration ||
      this.localGenerations.size > 0 ||
      this.generationCoordinator.length > 0
    ) {
      return
    }

    if (this.metrics.batchStartedAt !== null) {
      this.metrics.lastBatchDurationMs = performance.now() - this.metrics.batchStartedAt
      this.metrics.lastBatchCompleted = this.metrics.batchCompleted
      this.metrics.batchStartedAt = null
      this.metrics.batchCompleted = 0

      const tuningSnapshot = this.localBatchTuning
      this.localBatchTuning = null

      if (tuningSnapshot) {
        void this.observeLocalConcurrencyBatch(
          tuningSnapshot,
          this.metrics.lastBatchCompleted,
          this.metrics.lastBatchDurationMs
        )
      }
    }

    this.releaseBackgroundExecution()
    this.scheduleStagedPreviewReveal()
  }

  private async observeLocalConcurrencyBatch(
    snapshot: LocalBatchTuningSnapshot,
    completed: number,
    durationMs: number
  ) {
    const renderer = this.localBrowserRenderer
    const tuner = this.concurrencyTuner

    if (!renderer || !tuner) return

    const key = renderer.tuningKey
    const observation = tuner.observe(
      this.pluginData.localRendererTuning?.[key],
      snapshot,
      {
        localGenerationCount: this.metrics.localGenerationCount,
        localFallbacks: this.metrics.localFallbacks,
        generationPreemptions: this.metrics.generationPreemptions
      },
      completed,
      durationMs
    )

    if (!observation.shouldPersist || !observation.record) return

    if (!this.pluginData.localRendererTuning) {
      this.pluginData.localRendererTuning = {}
    }

    this.pluginData.localRendererTuning[key] = observation.record

    try {
      await this.saveData(this.pluginData)
    } catch (error) {
      this.log(error, true)
    }
  }

  private finishActiveGeneration(node: LinkNode, outcome: GenerationOutcome) {
    const session = this.activeGeneration

    if (!session || session.node !== node) return

    session.finish(outcome)
  }

  private abortActiveGeneration(requeue: boolean) {
    const session = this.activeGeneration

    if (!session) return

    session.requeue = requeue
    this.removeNodeFrame(session.node)
    session.finish('preempted')
  }

  private removeQueuedGeneration(node: LinkNode) {
    this.generationCoordinator.remove(node.id)
  }

  private handleNodeUrlChanged(node: LinkNode) {
    this.discardStagedPreview(node)

    const state = this.getNodeState(node)

    state.evaluated = false
    state.cached = false
    state.metadata = null
    state.preparation = null

    this.removeQueuedGeneration(node)

    const preview = node._previewImageEl

    if (preview?.isConnected) {
      preview.remove()
    }

    node._previewImageEl = null
    this.removePendingPlaceholder(node)

    if (this.generationPreload?.node === node) {
      this.cancelGenerationPreload(true)
    }

    this.abortLocalGenerationForNode(node, 'stale')

    if (this.activeInteractiveNode === node) {
      this.removeNodeFrame(node)
      this.clearInteractiveState(node)
    }

    const session = this.activeGeneration

    if (session?.node === node) {
      this.removeNodeFrame(node)
      session.finish('stale')
    }

    void this.prepareNode(node)
  }

  private handleBreakpointUpdate(node: LinkNode) {
    this.generationCoordinator.markPrioritiesDirty()

    const session = this.activeGeneration
    const isInteractive = this.activeInteractiveNode === node
    const isGenerating = session?.node === node
    const localGeneration = this.localGenerations.get(node.id)
    const isLocalGenerating = localGeneration?.node === node
    const isPreloading = this.generationPreload?.node === node

    if (
      !this.isNodeContentMounted(node) &&
      (isInteractive || isGenerating || isLocalGenerating || isPreloading)
    ) {
      this.ensureNodeContentMounted(node)
    }

    if (this.isNodeContentMounted(node)) {
      if (isGenerating && node.frameEl?.tagName !== 'WEBVIEW') {
        this.requestNodeFrame(node, 'generation')
      } else if (isPreloading && node.frameEl?.tagName !== 'WEBVIEW') {
        this.requestNodeFrame(node, 'preload')
      } else if (isInteractive && node.frameEl?.tagName !== 'WEBVIEW') {
        this.requestNodeFrame(node, 'interactive')
      }

      this.onNodeMounted(node)
      return
    }

    if (isInteractive) {
      this.removeNodeFrame(node)
      this.clearInteractiveState(node)
    }

    if (isPreloading) {
      this.cancelGenerationPreload(true)
    }

    if (isLocalGenerating) {
      this.abortLocalGenerationForNode(node, 'unmounted')
    }

    if (isGenerating) {
      this.removeNodeFrame(node)
      session.finish('unmounted')
    }
  }

  private requestNodeFrame(node: LinkNode, mode: FrameMode) {
    this.nodeRuntime.requestFrameMode(node, mode)
    node.recreateFrame()

    if (node.frameEl?.tagName === 'WEBVIEW') return

    if (mode === 'generation') {
      this.finishActiveGeneration(node, 'failure')
      return
    }

    if (mode === 'preload') {
      const preload = this.generationPreload

      if (preload?.node === node) {
        this.settleGenerationPreload(preload, false, true)
      }

      return
    }

    if (this.activeInteractiveNode === node) {
      this.clearInteractiveState(node)
    }
  }

  private requestInteractiveActivation(node: LinkNode) {
    this.interactiveActivation.request(node)
  }

  private async deactivateInteractive(node: LinkNode) {
    if (this.activeInteractiveNode !== node) return

    const state = this.getNodeState(node)

    if (state.cached && node.frameEl?.isConnected) {
      await this.showPreviewOverFrame(node)
    }

    this.removeNodeFrame(node)
    this.clearInteractiveState(node)

    if (!state.cached && this.isNodeContentMounted(node)) {
      this.ensurePendingPlaceholder(node)
      this.enqueueThumbnailGeneration(node, true)
    }
  }

  private removeInteractiveFrameImmediately() {
    const node = this.activeInteractiveNode

    if (!node) return

    this.removeNodeFrame(node)
    this.clearInteractiveState(node)
  }

  private pruneDetachedActiveResources() {
    const interactiveNode = this.activeInteractiveNode

    if (interactiveNode && !interactiveNode.nodeEl?.isConnected) {
      this.removeNodeFrame(interactiveNode)
      this.clearInteractiveState(interactiveNode)
    }

    const preload = this.generationPreload

    if (preload && !preload.node.nodeEl?.isConnected) {
      this.cancelGenerationPreload(true)
    }

    for (const localGeneration of [...this.localGenerations.values()]) {
      if (!localGeneration.node.nodeEl?.isConnected) {
        this.finishLocalGeneration(localGeneration, 'unmounted')
      }
    }

    const generation = this.activeGeneration

    if (generation && !generation.node.nodeEl?.isConnected) {
      this.removeNodeFrame(generation.node)
      generation.finish('unmounted')
    }
  }

  private clearInteractiveState(node: LinkNode) {
    if (this.activeInteractiveNode !== node) return

    this.setInteractiveClasses(node, false)

    if (this.interactiveActivation.clear(node)) {
      this.scheduleThumbnailQueue()
    }
  }

  private setInteractiveClasses(node: LinkNode, active: boolean) {
    const root = node.canvas?.wrapperEl ?? node.nodeEl.ownerDocument.body

    if (active) {
      node.updateNodeLabel(this.getNodeState(node).metadata?.title ?? node.url)
    }

    node.nodeEl.classList.toggle('canvas-web-active', active)
    root.classList.toggle('canvas-web-has-active', active)
  }

  private removeNodeFrame(node: LinkNode) {
    const frameEl = node.frameEl

    if (frameEl?.isConnected) {
      frameEl.remove()
    }

    if (node.frameEl === frameEl) {
      node.frameEl = null
    }
  }

  private configureFrame(node: LinkNode, mode: FrameMode) {
    const frameEl = node.frameEl

    if (frameEl?.tagName !== 'WEBVIEW') {
      if (mode === 'generation') {
        this.finishActiveGeneration(node, 'failure')
      } else if (mode === 'preload') {
        const preload = this.generationPreload

        if (preload?.node === node) {
          this.settleGenerationPreload(preload, false, true)
        }
      } else if (this.activeInteractiveNode === node) {
        this.ensurePreview(node, true)
        this.clearInteractiveState(node)
      }

      return
    }

    void this.forceWebviewLightPreference(frameEl, mode === 'interactive')

    if (mode === 'preload') {
      const preload = this.generationPreload

      if (!preload || preload.node !== node) {
        this.removeNodeFrame(node)
        return
      }

      preload.frameEl = frameEl

      const onReady = () => {
        void (async () => {
          if (node.frameEl !== frameEl || !frameEl.isConnected) {
            this.settleGenerationPreload(preload, false, true)
            return
          }

          const themeStartedAt = performance.now()
          await this.applyGenerationLightTheme(frameEl)
          this.metrics.themeTotalMs += performance.now() - themeStartedAt
          this.metrics.themeCount++

          const paintStartedAt = performance.now()

          try {
            await Promise.race([
              frameEl.executeJavaScript(WEBVIEW_PAINT_READY_SCRIPT),
              delay(GENERATION_PAINT_TIMEOUT_MS)
            ])
          } catch {
            // Best effort, matching the normal generation path.
          }

          this.metrics.paintReadyTotalMs += performance.now() - paintStartedAt
          this.metrics.paintReadyCount++

          if (node.frameEl !== frameEl || !frameEl.isConnected) {
            this.settleGenerationPreload(preload, false, true)
            return
          }

          preload.prepared = true
          this.settleGenerationPreload(preload, true)
        })()
      }
      const onFailed = (event: Event) => {
        if (!isFatalLoadFailure(event as DidFailLoadEvent)) return

        if (node.frameEl === frameEl) {
          this.removeNodeFrame(node)
        }

        this.settleGenerationPreload(preload, false)
      }

      preload.cleanup = () => {
        frameEl.removeEventListener('dom-ready', onReady)
        frameEl.removeEventListener('did-fail-load', onFailed)
      }

      frameEl.addEventListener('dom-ready', onReady, { once: true })
      frameEl.addEventListener('did-fail-load', onFailed)

      return
    }

    const onFrameFailed = (event: Event) => {
      if (!isFatalLoadFailure(event as DidFailLoadEvent)) return

      this.removeNodeFrame(node)

      if (mode === 'generation') {
        this.finishActiveGeneration(node, 'failure')
      } else if (this.activeInteractiveNode === node) {
        this.ensurePreview(node, true)
        this.clearInteractiveState(node)
      }
    }

    frameEl.addEventListener('did-fail-load', onFrameFailed)

    if (mode === 'generation') {
      const session = this.activeGeneration

      if (
        session?.node === node &&
        session.frameRequestedAt !== undefined &&
        session.frameCreatedAt === undefined
      ) {
        session.frameCreatedAt = performance.now()
        this.metrics.frameCreateTotalMs += session.frameCreatedAt - session.frameRequestedAt
        this.metrics.frameCreateCount++
      }

      frameEl.addEventListener(
        'dom-ready',
        () => {
          const currentSession = this.activeGeneration

          if (currentSession?.node === node && currentSession.domReadyAt === undefined) {
            currentSession.domReadyAt = performance.now()
            this.metrics.domReadyTotalMs +=
              currentSession.domReadyAt -
              (currentSession.frameCreatedAt ?? currentSession.startedAt)
            this.metrics.domReadyCount++
          }

          void this.captureGeneratedFrame(node, frameEl)
        },
        { once: true }
      )

      return
    }

    let lightReloadCompleted = false

    const onInteractiveReady = () => {
      void (async () => {
        if (
          this.activeInteractiveNode !== node ||
          node.frameEl !== frameEl ||
          !frameEl.isConnected
        ) {
          frameEl.removeEventListener('dom-ready', onInteractiveReady)
          return
        }

        if (!lightReloadCompleted) {
          const lightPreferenceApplied = await this.forceWebviewLightPreference(frameEl, true)

          if (
            lightPreferenceApplied &&
            this.activeInteractiveNode === node &&
            node.frameEl === frameEl &&
            frameEl.isConnected
          ) {
            // Obsidian creates the <webview> with its URL already assigned, so
            // site bootstrap code can run before CDP emulation is attached.
            // Reload once while the thumbnail is still covering the frame.
            // On the second navigation the page sees light preference from
            // its very first script/CSS evaluation, matching thumbnail capture.
            lightReloadCompleted = true
            frameEl.reload()
            return
          }
        }

        frameEl.removeEventListener('dom-ready', onInteractiveReady)
        await this.revealInteractiveFrame(node, frameEl)
      })()
    }

    frameEl.addEventListener('dom-ready', onInteractiveReady)
  }

  private async forceWebviewLightPreference(
    frameEl: LinkNode['frameEl'],
    trackInteractive = false
  ): Promise<boolean> {
    const result = await forceGuestLightPreference(frameEl)

    if (trackInteractive) {
      this.interactiveLightPreferenceStatus = result.status
    }

    if (result.error) {
      this.log(`Unable to force light color preference for webview: ${result.error.message}`, true)
    }

    return result.applied
  }

  private async applyLightTheme(frameEl: LinkNode['frameEl']): Promise<boolean> {
    if (!frameEl?.isConnected) return false

    const [preferenceResult] = await Promise.allSettled([
      this.forceWebviewLightPreference(frameEl, true),
      frameEl.insertCSS(GENERATION_LIGHT_THEME_CSS),
      frameEl.executeJavaScript(LIGHT_THEME_SCRIPT)
    ])

    const browserPreferenceIsLight = await frameEl
      .executeJavaScript("window.matchMedia('(prefers-color-scheme: light)').matches")
      .then(value => value === true)
      .catch(() => false)

    this.interactiveMatchMediaLight = browserPreferenceIsLight

    return (
      preferenceResult.status === 'fulfilled' && preferenceResult.value && browserPreferenceIsLight
    )
  }

  private async applyGenerationLightTheme(frameEl: LinkNode['frameEl']) {
    if (!frameEl?.isConnected) return

    await Promise.allSettled([
      this.forceWebviewLightPreference(frameEl, false),
      frameEl.insertCSS(GENERATION_LIGHT_THEME_CSS),
      frameEl.executeJavaScript(LIGHT_THEME_SCRIPT)
    ])
  }

  private async revealInteractiveFrame(node: LinkNode, frameEl: NonNullable<LinkNode['frameEl']>) {
    await this.applyLightTheme(frameEl)

    try {
      await frameEl.executeJavaScript(WEBVIEW_PAINT_READY_SCRIPT)
    } catch {
      // Best effort.
    }

    await delay(INTERACTIVE_PAINT_SETTLE_MS)

    if (this.activeInteractiveNode !== node || node.frameEl !== frameEl || !frameEl.isConnected) {
      return
    }

    const preview = node._previewImageEl

    if (!preview?.isConnected) return

    preview.classList.add('link-thumbnail-exit')

    afterTransition(preview, () => {
      if (node._previewImageEl !== preview) return

      preview.remove()
      node._previewImageEl = null
    })
  }

  private async captureGeneratedFrame(node: LinkNode, frameEl: NonNullable<LinkNode['frameEl']>) {
    const session = this.activeGeneration

    if (session?.node !== node || node.frameEl !== frameEl) return

    if (!session.preparedByPreload) {
      const themeStartedAt = performance.now()
      await this.applyGenerationLightTheme(frameEl)
      this.metrics.themeTotalMs += performance.now() - themeStartedAt
      this.metrics.themeCount++

      const paintStartedAt = performance.now()

      try {
        await Promise.race([
          frameEl.executeJavaScript(WEBVIEW_PAINT_READY_SCRIPT),
          delay(GENERATION_PAINT_TIMEOUT_MS)
        ])
      } catch {
        // Best effort.
      }

      this.metrics.paintReadyTotalMs += performance.now() - paintStartedAt
      this.metrics.paintReadyCount++
    }

    if (this.activeGeneration !== session) return

    if (!this.isThumbnailViewportCurrent(node, session.viewportWidth, session.viewportHeight)) {
      this.removeNodeFrame(node)
      session.finish('stale')
      return
    }

    if (node.frameEl !== frameEl || !frameEl.isConnected) {
      session.finish('failure')
      return
    }

    if (node.url !== session.url) {
      this.removeNodeFrame(node)
      session.finish('stale')
      return
    }

    const title = frameEl.getTitle()
    const saved = await node._saveThumbnail()

    if (!saved) {
      if (this.activeGeneration === session) {
        this.removeNodeFrame(node)
        session.finish('failure')
      }
      return
    }

    if (this.activeGeneration !== session) return

    if (node.frameEl !== frameEl || !frameEl.isConnected) {
      session.finish('failure')
      return
    }

    if (node.url !== session.url) {
      this.removeNodeFrame(node)
      session.finish('stale')
      return
    }

    if (!this.isThumbnailViewportCurrent(node, session.viewportWidth, session.viewportHeight)) {
      this.removeNodeFrame(node)
      session.finish('stale')
      return
    }

    const metadata: CacheMetadata = {
      version: CACHE_METADATA_VERSION,
      url: session.url,
      title,
      capturedAt: Date.now(),
      viewportWidth: session.viewportWidth,
      viewportHeight: session.viewportHeight
    }

    try {
      const metadataWriteStartedAt = performance.now()

      await this.previewCache.writeMetadata(node.id, metadata)

      this.metrics.metadataWriteTotalMs += performance.now() - metadataWriteStartedAt
      this.metrics.metadataWriteCount++
    } catch (error) {
      this.log(error, true)
      this.removeNodeFrame(node)
      session.finish('failure')
      return
    }

    const state = this.getNodeState(node)

    state.evaluated = true
    state.cached = true
    state.metadata = metadata

    node.updateNodeLabel(title)

    const previewStartedAt = performance.now()
    const previewReady = await this.stageGeneratedPreview(node)
    this.metrics.previewReadyTotalMs += performance.now() - previewStartedAt
    this.metrics.previewReadyCount++

    if (this.activeGeneration !== session) return

    if (!previewReady || !this.getNodeState(node).cached) {
      session.requeue = true
      this.removeNodeFrame(node)
      session.finish('failure')
      return
    }

    this.removeNodeFrame(node)
    this.log(`Cached link ${node.url}`)
    session.finish('success')
  }

  private optimizeThumbnail(image: ThumbnailImage): ThumbnailImage {
    const size = image.getSize()
    const longEdge = Math.max(size.width, size.height)

    if (longEdge <= THUMBNAIL_MAX_LONG_EDGE) return image

    const scale = THUMBNAIL_MAX_LONG_EDGE / longEdge

    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    })
  }

  private async saveThumbnail(node: LinkNode): Promise<boolean> {
    const frameEl = node.frameEl

    if (!frameEl?.isConnected) return false

    const startedAt = performance.now()

    try {
      const capturePageStartedAt = performance.now()
      const image = await frameEl.capturePage()
      this.metrics.capturePageTotalMs += performance.now() - capturePageStartedAt
      this.metrics.capturePageCount++

      if (node.frameEl !== frameEl || !frameEl.isConnected || image.isEmpty()) {
        return false
      }

      const encodeStartedAt = performance.now()
      const optimized = this.optimizeThumbnail(image)
      const jpeg = optimized.toJPEG(THUMBNAIL_JPEG_QUALITY)
      this.metrics.encodeTotalMs += performance.now() - encodeStartedAt
      this.metrics.encodeCount++

      const thumbnailWriteStartedAt = performance.now()
      await this.previewCache.writeThumbnail(node.id, jpeg)
      this.metrics.thumbnailWriteTotalMs += performance.now() - thumbnailWriteStartedAt
      this.metrics.thumbnailWriteCount++

      this.metrics.captureTotalMs += performance.now() - startedAt
      this.metrics.capturedThumbnailBytes += jpeg.byteLength

      return true
    } catch (error) {
      this.log(error, true)
      return false
    }
  }

  tryPatchLinkNode(): boolean {
    const canvas = (this.app.workspace.getLeavesOfType('canvas') as CanvasLeaf[]).find(
      leaf => leaf?.view?.canvas
    )?.view?.canvas

    if (!canvas) return false

    const linkNodeConstructor = this.retrieveLinkNodeConstructor(canvas)

    this.patchLinkNode(linkNodeConstructor)

    return true
  }

  patchLinkNode(linkNodeConstructor: LinkNodeConstructor): boolean {
    const uninstaller = installLinkNodePatches(linkNodeConstructor, {
      saveThumbnail: node => this.saveThumbnail(node),
      thumbnailPath: node => this.previewCache.thumbnailPath(node.id),
      metadataPath: node => this.previewCache.metadataPath(node.id),
      onMounted: node => this.onNodeMounted(node),
      onBreakpoint: node => this.handleBreakpointUpdate(node),
      onUrlChanged: node => this.handleNodeUrlChanged(node),
      onInitialized: node => {
        this.attachActivationHandler(node)
        void this.prepareNode(node)

        queueMicrotask(() => {
          this.rehydrateCachedNode(node)
        })
      },
      consumeFrameMode: node => {
        return this.nodeRuntime.consumeFrameMode(node)
      },
      onFrameCreated: (node, mode) => this.configureFrame(node, mode)
    })

    this.register(uninstaller)

    this.log('Canvas patched successfully')
    this.app.workspace.trigger(`${this.manifest.id}:patched-canvas`)

    return true
  }

  retrieveLinkNodeConstructor(canvasInstance: Canvas): LinkNodeConstructor {
    const dummyCanvasInstance = new Proxy(
      {},
      {
        get: () => () => {}
      }
    )

    const dummyNodeParams = {
      pos: {
        x: 0,
        y: 0
      },
      size: {
        width: 0,
        height: 0
      },
      position: 'center',
      url: '',
      save: false,
      focus: false
    }

    const dummyLinkNode = canvasInstance.createLinkNode.call(dummyCanvasInstance, dummyNodeParams)

    return dummyLinkNode.constructor as unknown as LinkNodeConstructor
  }

  resetDiagnostics() {
    const batchStartedAt =
      this.activeGeneration ||
      this.localGenerations.size > 0 ||
      this.generationCoordinator.length > 0
        ? performance.now()
        : null

    this.metrics.reset(batchStartedAt)
    this.interactiveLightPreferenceStatus = 'not attempted'
    this.interactiveMatchMediaLight = null
    this.localBrowserRenderer?.resetMetrics()
    this.networkPreconnector?.resetMetrics()

    new Notice('Canvas Web Optimizer diagnostics reset')
  }

  showDiagnostics() {
    const canvasLeaves = this.app.workspace.getLeavesOfType('canvas') as CanvasLeaf[]

    let cachedPreviews = 0
    let liveWebviews = 0
    const mountedWebCards = new Set<Element>()

    for (const leaf of canvasLeaves) {
      const previews = leaf.view.containerEl.querySelectorAll('.link-thumbnail')
      const webviews = leaf.view.containerEl.querySelectorAll('webview')

      cachedPreviews += previews.length
      liveWebviews += webviews.length

      previews.forEach(element => {
        const node = element.closest('.canvas-node')
        if (node) mountedWebCards.add(node)
      })

      webviews.forEach(element => {
        const node = element.closest('.canvas-node')
        if (node) mountedWebCards.add(node)
      })
    }

    const localRendererAvailable = this.localBrowserRenderer?.available ?? false
    const diagnostics = formatDiagnosticsReport({
      mountedWebCards: mountedWebCards.size,
      cachedPreviews,
      liveWebviews,
      generatingThumbnails: (this.activeGeneration ? 1 : 0) + this.localGenerations.size,
      queued: this.generationCoordinator.length,
      stagedPreviews: this.stagedPreviews.size,
      previewRevealActive: this.previewRevealPromise !== null,
      interactiveWebviewActive: Boolean(this.activeInteractiveNode),
      interactiveLightPreferenceStatus: this.interactiveLightPreferenceStatus,
      interactiveMatchMediaLight: this.interactiveMatchMediaLight,
      backgroundExecutionActive: this.backgroundExecution.active,
      generationPreloadDisabled: this.generationPreloadDisabled,
      metrics: this.metrics,
      localBrowser: {
        available: localRendererAvailable,
        poolSize: this.localBrowserRenderer?.poolSize ?? 0,
        status: this.localBrowserRenderer
          ? `${this.localBrowserRenderer.browserName} / ${this.localBrowserRenderer.state}`
          : 'not initialized',
        unavailableReason: this.localBrowserRenderer?.unavailableReason ?? 'none',
        hardwareSummary: this.localBrowserRenderer?.hardwareSummary ?? 'unknown',
        concurrencySummary: this.localBrowserRenderer?.concurrencySummary ?? 'unknown',
        tuningStatus: this.concurrencyTuner?.status ?? 'not initialized',
        activeTasks: this.localBrowserRenderer?.activeCount ?? 0,
        renderFailures: this.localBrowserRenderer?.renderFailureCount ?? 0,
        launches: this.localBrowserRenderer?.launchCount ?? 0,
        closes: this.localBrowserRenderer?.closeCount ?? 0,
        launchFailures: this.localBrowserRenderer?.launchFailureCount ?? 0,
        averageLaunchMs: this.localBrowserRenderer?.averageLaunchMs ?? 0,
        averageRenderMs: this.localBrowserRenderer?.averageRenderMs ?? 0,
        averageSetupMs: this.localBrowserRenderer?.averageSetupMs ?? 0,
        averageNavigationMs: this.localBrowserRenderer?.averageNavigationMs ?? 0,
        readinessProbeWins: this.localBrowserRenderer?.readinessProbeWinCount ?? 0,
        averagePaintReadyMs: this.localBrowserRenderer?.averagePaintReadyMs ?? 0,
        averageVisualSettleMs: this.localBrowserRenderer?.averageVisualSettleMs ?? 0,
        visualSettleMaxOuts: this.localBrowserRenderer?.visualSettleMaxOutCount ?? 0,
        visualSettleComplexPages: this.localBrowserRenderer?.visualSettleComplexPageCount ?? 0,
        visualSettleCommandFailures:
          this.localBrowserRenderer?.visualSettleCommandFailureCount ?? 0,
        loaderBypasses: this.localBrowserRenderer?.loaderBypassCount ?? 0,
        cookieCleanupActions: this.localBrowserRenderer?.cookieCleanupActionCount ?? 0,
        captureRecoveries: this.localBrowserRenderer?.captureRecoveryCount ?? 0,
        unresolvedSuspiciousCaptures:
          this.localBrowserRenderer?.unresolvedSuspiciousCaptureCount ?? 0,
        introWaits: this.localBrowserRenderer?.introWaitCount ?? 0,
        introNaturalResolutions: this.localBrowserRenderer?.introNaturalResolutionCount ?? 0,
        averageIntroWaitMs: this.localBrowserRenderer?.averageIntroWaitMs ?? 0,
        averageScreenshotMs: this.localBrowserRenderer?.averageScreenshotMs ?? 0,
        screenshotOptimizationStatus:
          this.localBrowserRenderer?.screenshotOptimizationStatus ?? 'not initialized',
        lastFailureSummary: this.localBrowserRenderer?.lastFailureSummary ?? 'none'
      },
      network: {
        preconnectActive: this.networkPreconnector?.active ?? false,
        preconnectCount: this.networkPreconnector?.count ?? 0,
        warmActive: this.networkPreconnector?.fetchActive ?? false,
        warmCompleted: this.networkPreconnector?.warmCompletedCount ?? 0,
        warmStarted: this.networkPreconnector?.warmStartedCount ?? 0,
        warmFailed: this.networkPreconnector?.warmFailedCount ?? 0
      }
    })

    this.log(diagnostics)

    new Notice(diagnostics, 10000)
  }

  async cleanupThumbnails() {
    const canvasFiles = this.app.vault.getFiles().filter(file => file.path.endsWith('.canvas'))
    const usedNodeIds = new Set<string>()

    for (const canvasFile of canvasFiles) {
      const content = await this.app.vault.read(canvasFile)
      const nodes = this.extractNodeIdsFromCanvas(content)

      nodes.forEach(nodeId => {
        usedNodeIds.add(nodeId)
      })
    }

    const removed = await this.previewCache.cleanupUnused(usedNodeIds)

    new Notice(`${removed} Unused thumbnails cleaned up!`)
  }

  extractNodeIdsFromCanvas(content: string): string[] {
    return extractCanvasNodeIds(content)
  }
}
