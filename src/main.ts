import { around } from 'monkey-around'
import {
  type Canvas,
  type CanvasLeaf,
  type CanvasNodeData,
  type LinkNode,
  type LinkNodeConstructor,
  Notice,
  Plugin
} from 'obsidian'
import BackgroundExecutionController from './background-execution'
import NetworkPreconnector from './network-preconnector'

const CACHE_METADATA_VERSION = 2
const CACHE_SCHEMA_VERSION = 2
const CACHE_SCHEMA_FILENAME = 'cache-schema.json'

const THUMBNAIL_JPEG_QUALITY = 76
const THUMBNAIL_MAX_LONG_EDGE = 896

const PREVIEW_TRANSITION_FALLBACK_MS = 250
const PREVIEW_LOAD_TIMEOUT_MS = 1000
const INTERACTIVE_PAINT_SETTLE_MS = 50
const GENERATION_PAINT_TIMEOUT_MS = 120
const GENERATION_JOB_TIMEOUT_MS = 5000
const GENERATION_MAX_ATTEMPTS = 3
const GENERATION_RETRY_DELAY_MS = 150
const PRECONNECT_LOOKAHEAD_ORIGINS = 6
const HTTP_WARM_LOOKAHEAD_URLS = 2

const GENERATION_LIGHT_THEME_CSS = `
  :root {
    color-scheme: light !important;
  }
`

const LIGHT_THEME_SCRIPT = `
  (() => {
    document.documentElement.style.setProperty('color-scheme', 'light', 'important')

    let meta = document.querySelector('meta[name="color-scheme"]')

    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'color-scheme')
      document.head?.appendChild(meta)
    }

    meta.setAttribute('content', 'light')
  })()
`

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

type FrameMode = 'generation' | 'preload' | 'interactive'
type GenerationOutcome = 'success' | 'failure' | 'timeout' | 'preempted' | 'stale' | 'unmounted'

type CacheMetadata = {
  version?: number
  url?: string
  title: string
  capturedAt?: number
}

type NodeState = {
  evaluated: boolean
  cached: boolean
  metadata: CacheMetadata | null
  preparation: Promise<void> | null
  activationHandlerAttached: boolean
}

type GenerationJob = {
  node: LinkNode
  attempt: number
  enqueuedAt: number
}

type ActiveGeneration = {
  node: LinkNode
  url: string
  startedAt: number
  frameRequestedAt?: number
  frameCreatedAt?: number
  domReadyAt?: number
  usedPreload?: boolean
  requeue: boolean
  finish: (outcome: GenerationOutcome) => void
}

type GenerationPreload = {
  node: LinkNode
  startedAt: number
  frameEl: NonNullable<LinkNode['frameEl']> | null
  readyPromise: Promise<boolean>
  resolveReady: (ready: boolean) => void
  settled: boolean
  cleanup: () => void
}

type DidFailLoadEvent = Event & {
  errorCode?: number
  isMainFrame?: boolean
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

function isFatalLoadFailure(event: DidFailLoadEvent): boolean {
  if (event.isMainFrame === false) return false

  // ERR_ABORTED is common during normal navigation/redirects.
  return event.errorCode !== -3
}

export default class CanvasWebOptimizerPlugin extends Plugin {
  name = 'Canvas Web Optimizer'

  cacheDir = `${this.manifest.dir}/data/linkCache`

  cacheHits = 0
  cacheMisses = 0

  private readonly thumbnailCacheIds = new Set<string>()
  private readonly metadataCacheIds = new Set<string>()
  private readonly metadataMemory = new Map<string, CacheMetadata>()
  private readonly nodeStates = new WeakMap<LinkNode, NodeState>()
  private readonly requestedFrameModes = new WeakMap<LinkNode, FrameMode>()
  private readonly pendingPlaceholders = new WeakMap<LinkNode, HTMLElement>()

  private generationQueue: GenerationJob[] = []
  private readonly queuedGenerationIds = new Set<string>()
  private activeGeneration: ActiveGeneration | null = null
  private generationPreload: GenerationPreload | null = null
  private generationPreloadDisabled = false
  private generationQueueScheduled = false
  private readonly backgroundExecution = new BackgroundExecutionController()
  private backgroundExecutionRelease: (() => void) | null = null
  private networkPreconnector: NetworkPreconnector | null = null

  private activeInteractiveNode: LinkNode | null = null
  private requestedInteractiveNode: LinkNode | null = null
  private interactiveTransitionRunning = false

  private generationCompleted = 0
  private generationFailed = 0
  private generationTimedOut = 0
  private generationPreemptions = 0
  private generationPreloadsStarted = 0
  private generationPreloadsReady = 0
  private generationPreloadHits = 0
  private generationPreloadFailures = 0
  private generationPreloadReadyTotalMs = 0
  private generationTotalMs = 0
  private queueWaitTotalMs = 0
  private queueWaitCount = 0
  private frameCreateTotalMs = 0
  private frameCreateCount = 0
  private domReadyTotalMs = 0
  private domReadyCount = 0
  private themeTotalMs = 0
  private themeCount = 0
  private paintReadyTotalMs = 0
  private paintReadyCount = 0
  private captureTotalMs = 0
  private capturePageTotalMs = 0
  private capturePageCount = 0
  private encodeTotalMs = 0
  private encodeCount = 0
  private thumbnailWriteTotalMs = 0
  private thumbnailWriteCount = 0
  private metadataWriteTotalMs = 0
  private metadataWriteCount = 0
  private previewReadyTotalMs = 0
  private previewReadyCount = 0
  private capturedThumbnailBytes = 0

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

    await this.app.vault.adapter.mkdir(this.cacheDir)
    await this.ensureCacheSchema()
    await this.buildCacheIndex()
    this.networkPreconnector = new NetworkPreconnector(this.getWebviewPartition())

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

    this.generationQueue = []
    this.queuedGenerationIds.clear()
    this.requestedInteractiveNode = null
    this.abortActiveGeneration(false)
    this.cancelGenerationPreload(true)
    this.removeInteractiveFrameImmediately()
    this.releaseBackgroundExecution()
    this.backgroundExecution.dispose()
    this.networkPreconnector = null

    this.reloadActiveCanvasViews()
  }

  reloadActiveCanvasViews() {
    this.app.workspace.getLeavesOfType('canvas').forEach(leaf => {
      leaf.rebuildView()
    })
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

  private async ensureCacheSchema() {
    const schemaPath = `${this.cacheDir}/${CACHE_SCHEMA_FILENAME}`
    let currentVersion = 0

    try {
      if (await this.app.vault.adapter.exists(schemaPath)) {
        const raw = await this.app.vault.adapter.read(schemaPath)
        const parsed = JSON.parse(raw) as { version?: number }
        currentVersion = parsed.version ?? 0
      }
    } catch (error) {
      this.log(error, true)
    }

    if (currentVersion === CACHE_SCHEMA_VERSION) return

    const listing = await this.app.vault.adapter.list(this.cacheDir)
    const staleFiles = listing.files.filter(path =>
      /(?:\.thumbnail\.jpg|\.metadata\.json|\/url-index\.json)$/.test(path)
    )

    await Promise.all(
      staleFiles.map(async path => {
        try {
          await this.app.vault.adapter.remove(path)
        } catch (error) {
          this.log(error, true)
        }
      })
    )

    await this.app.vault.adapter.write(
      schemaPath,
      JSON.stringify({
        version: CACHE_SCHEMA_VERSION,
        migratedAt: Date.now()
      })
    )
  }

  private async buildCacheIndex() {
    const listing = await this.app.vault.adapter.list(this.cacheDir)

    for (const path of listing.files) {
      const thumbnailMatch = path.match(/([^/]+)\.thumbnail\.jpg$/)

      if (thumbnailMatch) {
        this.thumbnailCacheIds.add(thumbnailMatch[1])
        continue
      }

      const metadataMatch = path.match(/([^/]+)\.metadata\.json$/)

      if (metadataMatch) {
        this.metadataCacheIds.add(metadataMatch[1])
      }
    }
  }

  private getNodeState(node: LinkNode): NodeState {
    const existing = this.nodeStates.get(node)

    if (existing) return existing

    const state: NodeState = {
      evaluated: false,
      cached: false,
      metadata: null,
      preparation: null,
      activationHandlerAttached: false
    }

    this.nodeStates.set(node, state)

    return state
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

  private prepareNode(node: LinkNode): Promise<void> {
    const state = this.getNodeState(node)

    if (state.evaluated) {
      this.applyPreparedNodeState(node, state)
      return Promise.resolve()
    }

    const cacheFilesExist =
      this.thumbnailCacheIds.has(node.id) && this.metadataCacheIds.has(node.id)

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

  private async evaluateNodeCache(node: LinkNode, state: NodeState) {
    try {
      let metadata = this.metadataMemory.get(node.id)

      if (!metadata) {
        const raw = await this.app.vault.adapter.read(`${this.cacheDir}/${node.id}.metadata.json`)
        metadata = JSON.parse(raw) as CacheMetadata
        this.metadataMemory.set(node.id, metadata)
      }

      if (metadata?.version !== CACHE_METADATA_VERSION || typeof metadata.title !== 'string') {
        this.markNodeCacheMiss(node, state)
        return
      }

      if (metadata.url && metadata.url !== node.url) {
        this.markNodeCacheMiss(node, state)
        return
      }

      state.evaluated = true
      state.cached = true
      state.metadata = metadata
      this.cacheHits++

      node.updateNodeLabel(metadata.title)
      this.applyPreparedNodeState(node, state)
    } catch (error) {
      this.log(error, true)
      this.markNodeCacheMiss(node, state)
    }
  }

  private markNodeCacheMiss(node: LinkNode, state: NodeState) {
    state.evaluated = true
    state.cached = false
    state.metadata = null

    this.thumbnailCacheIds.delete(node.id)
    this.metadataCacheIds.delete(node.id)
    this.metadataMemory.delete(node.id)
    this.cacheMisses++

    this.applyPreparedNodeState(node, state)
  }

  private applyPreparedNodeState(node: LinkNode, state: NodeState) {
    if (state.cached) {
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
  }

  private ensurePendingPlaceholder(node: LinkNode) {
    if (!this.isNodeContentMounted(node)) return

    const current = this.pendingPlaceholders.get(node)

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
    this.pendingPlaceholders.set(node, placeholder)
  }

  private removePendingPlaceholder(node: LinkNode) {
    const placeholder = this.pendingPlaceholders.get(node)

    if (placeholder?.isConnected) {
      placeholder.remove()
    }

    this.pendingPlaceholders.delete(node)
  }

  private setPendingStatus(node: LinkNode, message: string) {
    this.ensurePendingPlaceholder(node)

    const placeholder = this.pendingPlaceholders.get(node)
    const status = placeholder?.querySelector<HTMLElement>('.canvas-web-pending-status')

    if (status) {
      status.textContent = message
    }
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

    const preview = node.contentEl.doc.createElement('img')

    preview.classList.add('link-thumbnail')

    if (enterHidden) {
      preview.classList.add('link-thumbnail-enter')
    }

    preview.alt = 'Webpage thumbnail'
    preview.decoding = 'async'
    preview.draggable = false
    const resourcePath = this.app.vault.adapter.getResourcePath(
      `${this.cacheDir}/${node.id}.thumbnail.jpg`
    )
    const cacheVersion = this.getNodeState(node).metadata?.capturedAt

    if (cacheVersion) {
      const separator = resourcePath.includes('?') ? '&' : '?'
      preview.src = `${resourcePath}${separator}v=${cacheVersion}`
    } else {
      preview.src = resourcePath
    }

    preview.addEventListener(
      'error',
      () => {
        this.handlePreviewError(node, preview)
      },
      { once: true }
    )

    node.contentEl.append(preview)
    node._previewImageEl = preview

    return preview
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
    if (node._previewImageEl === preview) {
      preview.remove()
      node._previewImageEl = null
    }

    const state = this.getNodeState(node)
    state.evaluated = true
    state.cached = false
    state.metadata = null

    this.thumbnailCacheIds.delete(node.id)
    this.metadataCacheIds.delete(node.id)
    this.metadataMemory.delete(node.id)
    this.ensurePendingPlaceholder(node)

    if (this.activeGeneration?.node === node) {
      this.activeGeneration.requeue = true
      return
    }

    if (this.isNodeContentMounted(node)) {
      this.enqueueThumbnailGeneration(node)
    }
  }

  private enqueueThumbnailGeneration(node: LinkNode, front = false, attempt = 0) {
    const state = this.getNodeState(node)

    if (state.cached || !node.nodeEl?.isConnected) return

    if (this.activeGeneration?.node.id === node.id || this.queuedGenerationIds.has(node.id)) {
      return
    }

    const job: GenerationJob = {
      node,
      attempt,
      enqueuedAt: performance.now()
    }

    if (front) {
      this.generationQueue.unshift(job)
    } else {
      this.generationQueue.push(job)
    }

    this.queuedGenerationIds.add(node.id)
    this.scheduleThumbnailQueue()
  }

  private scheduleThumbnailQueue() {
    this.pruneDetachedActiveResources()

    if (
      this.activeGeneration ||
      this.activeInteractiveNode ||
      this.generationQueueScheduled ||
      this.generationQueue.length === 0
    ) {
      this.releaseBackgroundExecutionIfIdle()
      return
    }

    this.ensureBackgroundExecution(this.generationQueue[0].node)
    this.generationQueueScheduled = true

    queueMicrotask(() => {
      this.generationQueueScheduled = false
      void this.processThumbnailQueue()
    })
  }

  private async processThumbnailQueue() {
    if (this.activeGeneration || this.activeInteractiveNode) return

    this.preconnectQueuedWork()

    const job = this.dequeueNextGenerationJob()

    if (!job) {
      this.releaseBackgroundExecutionIfIdle()
      return
    }

    if (!this.ensureNodeContentMounted(job.node)) {
      this.generationQueue.unshift(job)
      this.queuedGenerationIds.add(job.node.id)
      return
    }

    this.warmQueuedWork()

    await this.generateQueuedThumbnail(job)

    if (!this.activeInteractiveNode) {
      this.scheduleThumbnailQueue()
    }
  }

  private preconnectQueuedWork() {
    if (!this.networkPreconnector || this.generationQueue.length === 0) return

    const urls = this.generationQueue
      .slice()
      .sort(
        (left, right) =>
          this.getGenerationPriority(left.node) - this.getGenerationPriority(right.node)
      )
      .map(job => job.node.url)

    this.networkPreconnector.preconnect(urls, PRECONNECT_LOOKAHEAD_ORIGINS)
  }

  private warmQueuedWork() {
    if (!this.networkPreconnector || this.generationQueue.length === 0) return

    const urls = this.generationQueue
      .slice()
      .sort(
        (left, right) =>
          this.getGenerationPriority(left.node) - this.getGenerationPriority(right.node)
      )
      .map(job => job.node.url)

    this.networkPreconnector.warm(urls, HTTP_WARM_LOOKAHEAD_URLS)
  }

  private peekNextGenerationJob(): GenerationJob | null {
    let bestJob: GenerationJob | null = null
    let bestPriority = Number.POSITIVE_INFINITY

    for (const job of this.generationQueue) {
      const { node } = job

      if (!node.nodeEl?.isConnected || this.getNodeState(node).cached) continue

      const priority = this.getGenerationPriority(node)

      if (priority <= bestPriority) {
        bestPriority = priority
        bestJob = job
      }
    }

    return bestJob
  }

  private startNextGenerationPreload() {
    if (
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
      readyPromise,
      resolveReady,
      settled: false,
      cleanup: () => {}
    }

    this.generationPreload = preload
    this.generationPreloadsStarted++
    this.requestNodeFrame(job.node, 'preload')
  }

  private settleGenerationPreload(preload: GenerationPreload, ready: boolean) {
    if (preload.settled) return

    preload.settled = true
    preload.cleanup()

    if (ready) {
      this.generationPreloadsReady++
      this.generationPreloadReadyTotalMs += performance.now() - preload.startedAt
    } else {
      this.generationPreloadFailures++
      this.generationPreloadDisabled = true

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

  private dequeueNextGenerationJob(): GenerationJob | null {
    let bestIndex = -1
    let bestPriority = Number.POSITIVE_INFINITY

    for (let index = this.generationQueue.length - 1; index >= 0; index--) {
      const job = this.generationQueue[index]
      const { node } = job

      if (!node.nodeEl?.isConnected) {
        this.generationQueue.splice(index, 1)
        this.queuedGenerationIds.delete(node.id)
        continue
      }

      const state = this.getNodeState(node)

      if (state.cached) {
        this.generationQueue.splice(index, 1)
        this.queuedGenerationIds.delete(node.id)
        continue
      }

      const priority = this.getGenerationPriority(node)

      if (priority <= bestPriority) {
        bestPriority = priority
        bestIndex = index
      }
    }

    if (bestIndex < 0) return null

    const [job] = this.generationQueue.splice(bestIndex, 1)
    this.queuedGenerationIds.delete(job.node.id)
    this.queueWaitTotalMs += performance.now() - job.enqueuedAt
    this.queueWaitCount++

    return job
  }

  private getGenerationPriority(node: LinkNode): number {
    const viewport = node.canvas?.getViewportBBox?.()

    if (
      !viewport ||
      typeof node.x !== 'number' ||
      typeof node.y !== 'number' ||
      typeof node.width !== 'number' ||
      typeof node.height !== 'number'
    ) {
      return 1
    }

    const nodeMinX = node.x
    const nodeMinY = node.y
    const nodeMaxX = node.x + node.width
    const nodeMaxY = node.y + node.height

    const intersects = (minX: number, minY: number, maxX: number, maxY: number) =>
      nodeMaxX >= minX && nodeMinX <= maxX && nodeMaxY >= minY && nodeMinY <= maxY

    if (intersects(viewport.minX, viewport.minY, viewport.maxX, viewport.maxY)) {
      return 0
    }

    const marginX = viewport.maxX - viewport.minX
    const marginY = viewport.maxY - viewport.minY

    if (
      intersects(
        viewport.minX - marginX,
        viewport.minY - marginY,
        viewport.maxX + marginX,
        viewport.maxY + marginY
      )
    ) {
      return 1
    }

    return 2
  }

  private generateQueuedThumbnail(job: GenerationJob): Promise<void> {
    const { node } = job

    return new Promise(resolve => {
      let completed = false

      const session: ActiveGeneration = {
        node,
        url: node.url,
        startedAt: performance.now(),
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
          this.generationCompleted++
          this.generationTotalMs += performance.now() - session.startedAt
        } else if (outcome === 'timeout') {
          this.generationTimedOut++
        } else if (outcome === 'failure') {
          this.generationFailed++
        } else if (outcome === 'preempted') {
          this.generationPreemptions++
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
          this.enqueueThumbnailGeneration(node, true, job.attempt)
        } else if (shouldRetryFailure) {
          this.setPendingStatus(
            node,
            `Retrying preview (${job.attempt + 2}/${GENERATION_MAX_ATTEMPTS})`
          )

          window.setTimeout(() => {
            this.enqueueThumbnailGeneration(node, true, job.attempt + 1)
          }, GENERATION_RETRY_DELAY_MS)
        } else {
          if ((outcome === 'failure' || outcome === 'timeout') && !this.getNodeState(node).cached) {
            this.setPendingStatus(node, 'Click to load live')
          }

          this.releaseBackgroundExecutionIfIdle()
        }
      }

      const preload =
        this.generationPreload?.node === node ? this.generationPreload : null

      if (this.generationPreload && !preload) {
        this.cancelGenerationPreload(true)
      }

      if (preload) {
        this.generationPreload = null
      }

      this.activeGeneration = session

      if (preload) {
        session.usedPreload = true
        this.generationPreloadHits++

        void preload.readyPromise.then(ready => {
          if (this.activeGeneration !== session) return

          const frameEl = preload.frameEl

          if (
            !ready ||
            !frameEl ||
            node.frameEl !== frameEl ||
            !frameEl.isConnected
          ) {
            session.finish('failure')
            return
          }

          void this.captureGeneratedFrame(node, frameEl)
        })
      } else {
        session.frameRequestedAt = performance.now()
        this.requestNodeFrame(node, 'generation')
      }

      this.startNextGenerationPreload()
    })
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
    if (this.activeGeneration || this.generationQueue.length > 0) return

    this.releaseBackgroundExecution()
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
    if (!this.queuedGenerationIds.delete(node.id)) return

    const index = this.generationQueue.findIndex(job => job.node === node)

    if (index >= 0) {
      this.generationQueue.splice(index, 1)
    }
  }

  private handleNodeUrlChanged(node: LinkNode) {
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
    const session = this.activeGeneration
    const isInteractive = this.activeInteractiveNode === node
    const isGenerating = session?.node === node
    const isPreloading = this.generationPreload?.node === node

    if (!this.isNodeContentMounted(node) && (isInteractive || isGenerating || isPreloading)) {
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

    if (isGenerating) {
      this.removeNodeFrame(node)
      session.finish('unmounted')
    }
  }

  private requestNodeFrame(node: LinkNode, mode: FrameMode) {
    this.requestedFrameModes.set(node, mode)
    node.recreateFrame()

    if (node.frameEl?.tagName === 'WEBVIEW') return

    if (mode === 'generation') {
      this.finishActiveGeneration(node, 'failure')
      return
    }

    if (mode === 'preload') {
      const preload = this.generationPreload

      if (preload?.node === node) {
        this.settleGenerationPreload(preload, false)
      }

      return
    }

    if (this.activeInteractiveNode === node) {
      this.clearInteractiveState(node)
    }
  }

  private requestInteractiveActivation(node: LinkNode) {
    this.requestedInteractiveNode = node

    if (this.interactiveTransitionRunning) return

    void this.processInteractiveActivationRequests()
  }

  private async processInteractiveActivationRequests() {
    if (this.interactiveTransitionRunning) return

    this.interactiveTransitionRunning = true

    try {
      while (this.requestedInteractiveNode) {
        const requestedNode = this.requestedInteractiveNode
        this.requestedInteractiveNode = null

        if (
          !this.isNodeContentMounted(requestedNode) ||
          this.activeInteractiveNode === requestedNode
        ) {
          continue
        }

        if (this.activeInteractiveNode) {
          await this.deactivateInteractive(this.activeInteractiveNode)
        }

        if (this.requestedInteractiveNode) {
          continue
        }

        if (!this.isNodeContentMounted(requestedNode)) {
          continue
        }

        this.cancelGenerationPreload(true)
        this.abortActiveGeneration(true)
        this.releaseBackgroundExecution()
        this.removePendingPlaceholder(requestedNode)

        this.activeInteractiveNode = requestedNode
        this.setInteractiveClasses(requestedNode, true)
        this.requestNodeFrame(requestedNode, 'interactive')
      }
    } finally {
      this.interactiveTransitionRunning = false

      if (this.requestedInteractiveNode) {
        void this.processInteractiveActivationRequests()
      }
    }
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

    const generation = this.activeGeneration

    if (generation && !generation.node.nodeEl?.isConnected) {
      this.removeNodeFrame(generation.node)
      generation.finish('unmounted')
    }
  }

  private clearInteractiveState(node: LinkNode) {
    if (this.activeInteractiveNode !== node) return

    this.setInteractiveClasses(node, false)
    this.activeInteractiveNode = null
    this.scheduleThumbnailQueue()
  }

  private setInteractiveClasses(node: LinkNode, active: boolean) {
    const root = node.canvas?.wrapperEl ?? node.nodeEl.ownerDocument.body

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
          this.settleGenerationPreload(preload, false)
        }
      } else if (this.activeInteractiveNode === node) {
        this.ensurePreview(node, true)
        this.clearInteractiveState(node)
      }

      return
    }

    if (mode === 'preload') {
      const preload = this.generationPreload

      if (!preload || preload.node !== node) {
        this.removeNodeFrame(node)
        return
      }

      preload.frameEl = frameEl

      const onReady = () => {
        if (node.frameEl !== frameEl || !frameEl.isConnected) {
          this.settleGenerationPreload(preload, false)
          return
        }

        this.settleGenerationPreload(preload, true)
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
        this.frameCreateTotalMs += session.frameCreatedAt - session.frameRequestedAt
        this.frameCreateCount++
      }

      frameEl.addEventListener(
        'dom-ready',
        () => {
          const currentSession = this.activeGeneration

          if (currentSession?.node === node && currentSession.domReadyAt === undefined) {
            currentSession.domReadyAt = performance.now()
            this.domReadyTotalMs +=
              currentSession.domReadyAt -
              (currentSession.frameCreatedAt ?? currentSession.startedAt)
            this.domReadyCount++
          }

          void this.captureGeneratedFrame(node, frameEl)
        },
        { once: true }
      )

      return
    }

    frameEl.addEventListener(
      'dom-ready',
      () => {
        void this.revealInteractiveFrame(node, frameEl)
      },
      { once: true }
    )
  }

  private async applyLightTheme(frameEl: LinkNode['frameEl']) {
    if (!frameEl?.isConnected) return

    await Promise.allSettled([frameEl.executeJavaScript(LIGHT_THEME_SCRIPT)])
  }

  private async applyGenerationLightTheme(frameEl: LinkNode['frameEl']) {
    if (!frameEl?.isConnected) return

    await Promise.allSettled([frameEl.insertCSS(GENERATION_LIGHT_THEME_CSS)])
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

    const themeStartedAt = performance.now()
    await this.applyGenerationLightTheme(frameEl)
    this.themeTotalMs += performance.now() - themeStartedAt
    this.themeCount++

    const paintStartedAt = performance.now()

    try {
      await Promise.race([
        frameEl.executeJavaScript(WEBVIEW_PAINT_READY_SCRIPT),
        delay(GENERATION_PAINT_TIMEOUT_MS)
      ])
    } catch {
      // Best effort.
    }

    this.paintReadyTotalMs += performance.now() - paintStartedAt
    this.paintReadyCount++

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

    const metadata: CacheMetadata = {
      version: CACHE_METADATA_VERSION,
      url: session.url,
      title,
      capturedAt: Date.now()
    }

    try {
      const metadataWriteStartedAt = performance.now()

      await this.app.vault.adapter.write(
        `${this.cacheDir}/${node.id}.metadata.json`,
        JSON.stringify(metadata)
      )

      this.metadataWriteTotalMs += performance.now() - metadataWriteStartedAt
      this.metadataWriteCount++
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

    this.thumbnailCacheIds.add(node.id)
    this.metadataCacheIds.add(node.id)
    this.metadataMemory.set(node.id, metadata)

    node.updateNodeLabel(title)

    const previewStartedAt = performance.now()
    const previewReady = await this.showPreviewOverFrame(node, false)
    this.previewReadyTotalMs += performance.now() - previewStartedAt
    this.previewReadyCount++

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
      this.capturePageTotalMs += performance.now() - capturePageStartedAt
      this.capturePageCount++

      if (node.frameEl !== frameEl || !frameEl.isConnected || image.isEmpty()) {
        return false
      }

      const encodeStartedAt = performance.now()
      const optimized = this.optimizeThumbnail(image)
      const jpeg = optimized.toJPEG(THUMBNAIL_JPEG_QUALITY)
      this.encodeTotalMs += performance.now() - encodeStartedAt
      this.encodeCount++

      const thumbnailWriteStartedAt = performance.now()
      await this.app.vault.adapter.writeBinary(`${this.cacheDir}/${node.id}.thumbnail.jpg`, jpeg)
      this.thumbnailWriteTotalMs += performance.now() - thumbnailWriteStartedAt
      this.thumbnailWriteCount++

      this.captureTotalMs += performance.now() - startedAt
      this.capturedThumbnailBytes += jpeg.byteLength

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
    const thisPlugin = this

    const uninstaller = around(linkNodeConstructor.prototype, {
      _saveThumbnail: () =>
        async function () {
          return thisPlugin.saveThumbnail(this)
        },

      _getThumbnailPath: () =>
        function () {
          return `${thisPlugin.cacheDir}/${this.id}.thumbnail.jpg`
        },

      _getMetadataPath: () =>
        function () {
          return `${thisPlugin.cacheDir}/${this.id}.metadata.json`
        },

      mountContent: (next: (...args: unknown[]) => unknown) =>
        function (...args: unknown[]) {
          const result = next.call(this, ...args)

          if (!this._initializing) {
            thisPlugin.onNodeMounted(this)
          }

          return result
        },

      updateBreakpoint: (next: (...args: unknown[]) => unknown) =>
        function (...args: unknown[]) {
          const result = next.call(this, ...args)

          thisPlugin.handleBreakpointUpdate(this)

          return result
        },

      setData: (next: (...args: unknown[]) => unknown) =>
        function (...args: unknown[]) {
          const previousUrl = this.url
          const result = next.call(this, ...args)

          if (previousUrl && previousUrl !== this.url) {
            thisPlugin.handleNodeUrlChanged(this)
          }

          return result
        },

      initialize: (next: (...args: unknown[]) => unknown) =>
        function (...args: unknown[]) {
          this._initializing = true

          let result: unknown

          try {
            result = next.call(this, ...args)
          } finally {
            this._initializing = false
          }

          thisPlugin.attachActivationHandler(this)
          void thisPlugin.prepareNode(this)

          return result
        },

      recreateFrame: (next: (...args: unknown[]) => unknown) =>
        function (...args: unknown[]) {
          if (this._initializing) return null

          const mode = thisPlugin.requestedFrameModes.get(this)

          if (!mode) {
            thisPlugin.onNodeMounted(this)
            return null
          }

          thisPlugin.requestedFrameModes.delete(this)

          const result = next.call(this, ...args)

          thisPlugin.configureFrame(this, mode)

          return result
        }
    })

    this.register(uninstaller)

    thisPlugin.log('Canvas patched successfully')
    thisPlugin.app.workspace.trigger(`${thisPlugin.manifest.id}:patched-canvas`)

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
    this.generationTotalMs = 0
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

    const averageGenerationMs =
      this.generationCompleted > 0
        ? Math.round(this.generationTotalMs / this.generationCompleted)
        : 0

    const averageCaptureMs =
      this.generationCompleted > 0 ? Math.round(this.captureTotalMs / this.generationCompleted) : 0
    const averagePreloadReadyMs =
      this.generationPreloadsReady > 0
        ? Math.round(this.generationPreloadReadyTotalMs / this.generationPreloadsReady)
        : 0
    const averageQueueWaitMs =
      this.queueWaitCount > 0 ? Math.round(this.queueWaitTotalMs / this.queueWaitCount) : 0
    const averageFrameCreateMs =
      this.frameCreateCount > 0 ? Math.round(this.frameCreateTotalMs / this.frameCreateCount) : 0
    const averageDomReadyMs =
      this.domReadyCount > 0 ? Math.round(this.domReadyTotalMs / this.domReadyCount) : 0
    const averageThemeMs = this.themeCount > 0 ? Math.round(this.themeTotalMs / this.themeCount) : 0
    const averagePaintReadyMs =
      this.paintReadyCount > 0 ? Math.round(this.paintReadyTotalMs / this.paintReadyCount) : 0
    const averageCapturePageMs =
      this.capturePageCount > 0 ? Math.round(this.capturePageTotalMs / this.capturePageCount) : 0
    const averageEncodeMs =
      this.encodeCount > 0 ? Math.round(this.encodeTotalMs / this.encodeCount) : 0
    const averageThumbnailWriteMs =
      this.thumbnailWriteCount > 0
        ? Math.round(this.thumbnailWriteTotalMs / this.thumbnailWriteCount)
        : 0
    const averageMetadataWriteMs =
      this.metadataWriteCount > 0
        ? Math.round(this.metadataWriteTotalMs / this.metadataWriteCount)
        : 0
    const averagePreviewReadyMs =
      this.previewReadyCount > 0 ? Math.round(this.previewReadyTotalMs / this.previewReadyCount) : 0

    const diagnostics = [
      `Mounted web cards: ${mountedWebCards.size}`,
      `Cached previews: ${cachedPreviews}`,
      `Live webviews: ${liveWebviews}`,
      `Generating thumbnails: ${this.activeGeneration ? 1 : 0}`,
      `Queued: ${this.generationQueue.length}`,
      `Interactive webview: ${this.activeInteractiveNode ? 1 : 0}`,
      `Background execution: ${this.backgroundExecution.active ? 'on' : 'off'}`,
      `Network preconnect: ${this.networkPreconnector?.active ? 'on' : 'off'} (${this.networkPreconnector?.count ?? 0})`,
      `HTTP warm cache: ${this.networkPreconnector?.fetchActive ? 'on' : 'off'} (${this.networkPreconnector?.warmCompletedCount ?? 0}/${this.networkPreconnector?.warmStartedCount ?? 0}, failed ${this.networkPreconnector?.warmFailedCount ?? 0})`,
      `Cache hits: ${this.cacheHits}`,
      `Cache misses: ${this.cacheMisses}`,
      `Generated: ${this.generationCompleted}`,
      `Generation failures: ${this.generationFailed}`,
      `Generation timeouts: ${this.generationTimedOut}`,
      `Generation preemptions: ${this.generationPreemptions}`,
      `Generation preload: ${this.generationPreloadDisabled ? 'disabled' : 'enabled'}`,
      `Preloads started/ready/hit/failed: ${this.generationPreloadsStarted}/${this.generationPreloadsReady}/${this.generationPreloadHits}/${this.generationPreloadFailures}`,
      `Average preload ready: ${averagePreloadReadyMs} ms`,
      `Average queue wait: ${averageQueueWaitMs} ms`,
      `Average frame create: ${averageFrameCreateMs} ms`,
      `Average DOM ready: ${averageDomReadyMs} ms`,
      `Average theme apply: ${averageThemeMs} ms`,
      `Average paint ready: ${averagePaintReadyMs} ms`,
      `Average capturePage: ${averageCapturePageMs} ms`,
      `Average encode: ${averageEncodeMs} ms`,
      `Average thumbnail write: ${averageThumbnailWriteMs} ms`,
      `Average metadata write: ${averageMetadataWriteMs} ms`,
      `Average preview ready: ${averagePreviewReadyMs} ms`,
      `Average generation: ${averageGenerationMs} ms`,
      `Average capture pipeline: ${averageCaptureMs} ms`,
      `Thumbnail bytes written: ${this.capturedThumbnailBytes}`
    ].join('\n')

    this.log(diagnostics)

    new Notice(diagnostics, 10000)
  }

  async cleanupThumbnails() {
    const thumbnails = await this.app.vault.adapter.list(this.cacheDir)

    const cachedNodeIds = new Set<string>()

    for (const file of thumbnails.files) {
      const match = file.match(/([^/]+)\.(?:thumbnail\.jpg|metadata\.json)$/)

      if (match) {
        cachedNodeIds.add(match[1])
      }
    }

    const canvasFiles = this.app.vault.getFiles().filter(file => file.path.endsWith('.canvas'))
    const usedNodeIds = new Set<string>()

    for (const canvasFile of canvasFiles) {
      const content = await this.app.vault.read(canvasFile)
      const nodes = this.extractNodeIdsFromCanvas(content)

      nodes.forEach(nodeId => {
        usedNodeIds.add(nodeId)
      })
    }

    const unusedNodeIds = [...cachedNodeIds].filter(nodeId => !usedNodeIds.has(nodeId))

    for (const nodeId of unusedNodeIds) {
      this.log(`Removing cache for missing node ${nodeId}`)

      const thumbnailFile = `${this.cacheDir}/${nodeId}.thumbnail.jpg`
      const metadataFile = `${this.cacheDir}/${nodeId}.metadata.json`

      const removeFile = async (path: string) => {
        if (await this.app.vault.adapter.exists(path)) {
          await this.app.vault.adapter.remove(path)
        }
      }

      await removeFile(thumbnailFile)
      await removeFile(metadataFile)

      this.thumbnailCacheIds.delete(nodeId)
      this.metadataCacheIds.delete(nodeId)
      this.metadataMemory.delete(nodeId)
    }

    new Notice(`${unusedNodeIds.length} Unused thumbnails cleaned up!`)
  }

  extractNodeIdsFromCanvas(content: string): string[] {
    const canvas = JSON.parse(content)

    return (canvas.nodes || []).map((node: CanvasNodeData) => node.id)
  }
}
