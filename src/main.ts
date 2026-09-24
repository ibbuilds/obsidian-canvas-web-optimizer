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
import CaptureWorkerPool, {
  type CaptureWorker,
  type CaptureWorkerFrame,
  type CaptureWorkerImage
} from './capture-worker-pool'
import NetworkPreconnector from './network-preconnector'

const CACHE_METADATA_VERSION = 1
const URL_CACHE_INDEX_VERSION = 1
const URL_CACHE_INDEX_FILENAME = 'url-index.json'
const URL_CACHE_INDEX_WRITE_DELAY_MS = 1000

const THUMBNAIL_JPEG_QUALITY = 72
const THUMBNAIL_MIN_LONG_EDGE = 512
const THUMBNAIL_MAX_LONG_EDGE = 768
const THUMBNAIL_NODE_SCALE = 1.25

const PREVIEW_TRANSITION_FALLBACK_MS = 250
const PREVIEW_LOAD_TIMEOUT_MS = 500
const INTERACTIVE_PAINT_SETTLE_MS = 50
const GENERATION_PAINT_TIMEOUT_MS = 80
const GENERATION_CAPTURE_RETRY_MS = 60
const GENERATION_FIRST_PASS_TIMEOUT_MS = 2500
const GENERATION_RETRY_TIMEOUT_MS = 6000
const FOREGROUND_GENERATION_CONCURRENCY = 2
const BACKGROUND_GENERATION_CONCURRENCY = 3
const HIGH_END_BACKGROUND_GENERATION_CONCURRENCY = 4
const BACKGROUND_THREE_WORKER_MIN_CORES = 8
const BACKGROUND_FOUR_WORKER_MIN_CORES = 12
const VIEWPORT_REBALANCE_INTERVAL_MS = 120
const PRECONNECT_LOOKAHEAD_ORIGINS = 8
const PRECONNECT_QUEUE_SAMPLE_SIZE = 24
const DEDICATED_WORKER_FAILURE_THRESHOLD = 2

const LIGHT_THEME_CSS = `
  :root {
    color-scheme: light !important;
  }
`

const LIGHT_THEME_SCRIPT = `
  (() => {
    document.documentElement.style.colorScheme = 'light'

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

const GENERATION_READY_SCRIPT = `
  (() => {
    document.documentElement.style.setProperty('color-scheme', 'light', 'important')

    let meta = document.querySelector('meta[name="color-scheme"]')

    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'color-scheme')
      document.head?.appendChild(meta)
    }

    meta.setAttribute('content', 'light')

    for (const media of document.querySelectorAll('video, audio')) {
      media.muted = true
      media.pause()
    }

    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming()

      if (!Number.isFinite(timing?.endTime)) continue

      try {
        animation.finish()
      } catch {
        // Some animations cannot be finished programmatically.
      }
    }

    return new Promise(resolve => {
      requestAnimationFrame(resolve)
    })
  })()
`

type ThumbnailImage = CaptureWorkerImage

type FrameMode = 'generation' | 'interactive'
type GenerationOutcome =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'preempted'
  | 'stale'
  | 'unmounted'
  | 'worker-fallback'

type CacheMetadata = {
  version?: number
  url?: string
  title: string
  capturedAt?: number
}

type UrlCacheIndex = {
  version: number
  entries: Record<string, string>
}

type NodeState = {
  evaluated: boolean
  cached: boolean
  metadata: CacheMetadata | null
  preparation: Promise<void> | null
  activationHandlerAttached: boolean
  mounted: boolean | null
}

type GenerationJob = {
  node: LinkNode
  enqueuedAt: number
  attempt: number
  forceNative: boolean
}

type ActiveGeneration = {
  node: LinkNode
  url: string
  startedAt: number
  domReadyAt?: number
  requeue: boolean
  attempt: number
  worker: CaptureWorker | null
  finish: (outcome: GenerationOutcome) => void
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

function normalizeCacheUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

export default class CanvasWebOptimizerPlugin extends Plugin {
  name = 'Canvas Web Optimizer'

  cacheDir = `${this.manifest.dir}/data/linkCache`

  cacheHits = 0
  cacheMisses = 0

  private readonly thumbnailCacheIds = new Set<string>()
  private readonly metadataCacheIds = new Set<string>()
  private readonly metadataMemory = new Map<string, CacheMetadata>()
  private readonly urlCacheSources = new Map<string, string>()
  private urlCacheIndexWriteTimer = 0
  private urlCacheIndexDirty = false
  private readonly nodeStates = new WeakMap<LinkNode, NodeState>()
  private readonly requestedFrameModes = new WeakMap<LinkNode, FrameMode>()
  private readonly pendingPlaceholders = new WeakMap<LinkNode, HTMLElement>()

  private generationQueue: GenerationJob[] = []
  private readonly queuedGenerationIds = new Set<string>()
  private readonly activeGenerations = new Map<string, ActiveGeneration>()
  private generationQueueScheduled = false
  private readonly backgroundExecution = new BackgroundExecutionController()
  private backgroundExecutionRelease: (() => void) | null = null
  private captureWorkerPool: CaptureWorkerPool | null = null
  private networkPreconnector: NetworkPreconnector | null = null
  private dedicatedWorkersDisabled = false
  private consecutiveDedicatedWorkerFailures = 0

  private activeInteractiveNode: LinkNode | null = null
  private requestedInteractiveNode: LinkNode | null = null
  private interactiveTransitionRunning = false

  private generationCompleted = 0
  private generationFailed = 0
  private generationTimedOut = 0
  private generationPreemptions = 0
  private dedicatedWorkerFallbacks = 0
  private generationTotalMs = 0
  private generationDomReadyTotalMs = 0
  private generationDomReadyCount = 0
  private queueWaitTotalMs = 0
  private dequeuedGenerationJobs = 0
  private peakGenerationWorkers = 0
  private lastViewportRebalanceAt = 0
  private batchStartedAt: number | null = null
  private batchCompleted = 0
  private lastBatchDurationMs = 0
  private lastBatchCompleted = 0
  private captureTotalMs = 0
  private capturePageTotalMs = 0
  private encodeTotalMs = 0
  private writeTotalMs = 0
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
    await this.buildCacheIndex()

    const webviewPartition = this.getWebviewPartition()
    this.captureWorkerPool = new CaptureWorkerPool(webviewPartition)
    this.networkPreconnector = new NetworkPreconnector(webviewPartition)

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
    this.abortActiveGenerations(false)
    this.removeInteractiveFrameImmediately()
    this.releaseBackgroundExecution()
    this.backgroundExecution.dispose()
    this.captureWorkerPool?.disposeAll()
    this.captureWorkerPool = null
    this.networkPreconnector = null

    if (this.urlCacheIndexWriteTimer !== 0) {
      window.clearTimeout(this.urlCacheIndexWriteTimer)
      this.urlCacheIndexWriteTimer = 0
    }

    if (this.urlCacheIndexDirty) {
      void this.persistUrlCacheIndex()
    }

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

  private getGenerationFrame(session: ActiveGeneration): CaptureWorkerFrame | null {
    if (session.worker) return session.worker.frame

    const frameEl = session.node.frameEl

    return frameEl?.tagName === 'WEBVIEW' ? (frameEl as CaptureWorkerFrame) : null
  }

  private isGenerationFrameCurrent(
    session: ActiveGeneration,
    frameEl: CaptureWorkerFrame
  ): boolean {
    if (this.activeGenerations.get(session.node.id) !== session || !frameEl.isConnected) {
      return false
    }

    if (session.worker) {
      return session.worker.frame === frameEl
    }

    return session.node.frameEl === frameEl
  }

  private cancelGenerationTransport(session: ActiveGeneration) {
    if (session.worker) {
      this.captureWorkerPool?.cancel(session.worker)
      return
    }

    this.removeNodeFrame(session.node)
  }

  log(msg: unknown, debug = false) {
    if (debug) {
      console.debug(`[${this.name}]`, msg)
      return
    }

    console.log(`[${this.name}]`, msg)
  }

  private async buildCacheIndex() {
    const listing = await this.app.vault.adapter.list(this.cacheDir)
    const urlIndexPath = `${this.cacheDir}/${URL_CACHE_INDEX_FILENAME}`

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

    if (!listing.files.includes(urlIndexPath)) return

    try {
      const raw = await this.app.vault.adapter.read(urlIndexPath)
      const index = JSON.parse(raw) as UrlCacheIndex

      if (index.version !== URL_CACHE_INDEX_VERSION || !index.entries) return

      for (const [url, nodeId] of Object.entries(index.entries)) {
        if (this.thumbnailCacheIds.has(nodeId) && this.metadataCacheIds.has(nodeId)) {
          this.urlCacheSources.set(url, nodeId)
        }
      }
    } catch (error) {
      this.log(error, true)
    }
  }

  private scheduleUrlCacheIndexWrite() {
    this.urlCacheIndexDirty = true

    if (this.urlCacheIndexWriteTimer !== 0) return

    this.urlCacheIndexWriteTimer = window.setTimeout(() => {
      this.urlCacheIndexWriteTimer = 0
      void this.persistUrlCacheIndex()
    }, URL_CACHE_INDEX_WRITE_DELAY_MS)
  }

  private async persistUrlCacheIndex() {
    if (!this.urlCacheIndexDirty) return

    this.urlCacheIndexDirty = false

    const index: UrlCacheIndex = {
      version: URL_CACHE_INDEX_VERSION,
      entries: Object.fromEntries(this.urlCacheSources)
    }

    try {
      await this.app.vault.adapter.write(
        `${this.cacheDir}/${URL_CACHE_INDEX_FILENAME}`,
        JSON.stringify(index)
      )
    } catch (error) {
      this.urlCacheIndexDirty = true
      this.log(error, true)
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
      activationHandlerAttached: false,
      mounted: null
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
      if (state.preparation) return state.preparation

      state.preparation = this.tryReuseUrlCache(node, state).finally(() => {
        state.preparation = null
      })

      return state.preparation
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

  private async tryReuseUrlCache(node: LinkNode, state: NodeState) {
    const normalizedUrl = normalizeCacheUrl(node.url)
    const sourceNodeId = this.urlCacheSources.get(normalizedUrl)

    if (
      !sourceNodeId ||
      sourceNodeId === node.id ||
      !this.thumbnailCacheIds.has(sourceNodeId) ||
      !this.metadataCacheIds.has(sourceNodeId)
    ) {
      this.markNodeCacheMiss(node, state)
      return
    }

    try {
      const metadataPath = `${this.cacheDir}/${sourceNodeId}.metadata.json`
      const thumbnailPath = `${this.cacheDir}/${sourceNodeId}.thumbnail.jpg`
      const rawMetadata = await this.app.vault.adapter.read(metadataPath)
      const sourceMetadata = JSON.parse(rawMetadata) as CacheMetadata

      if (
        typeof sourceMetadata.title !== 'string' ||
        (sourceMetadata.url && normalizeCacheUrl(sourceMetadata.url) !== normalizedUrl)
      ) {
        this.urlCacheSources.delete(normalizedUrl)
        this.scheduleUrlCacheIndexWrite()
        this.markNodeCacheMiss(node, state)
        return
      }

      const metadata: CacheMetadata = {
        version: CACHE_METADATA_VERSION,
        url: node.url,
        title: sourceMetadata.title,
        capturedAt: sourceMetadata.capturedAt ?? Date.now()
      }

      const destinationThumbnailPath = `${this.cacheDir}/${node.id}.thumbnail.jpg`

      const copyThumbnail = async () => {
        try {
          await this.app.vault.adapter.copy(thumbnailPath, destinationThumbnailPath)
        } catch {
          if (await this.app.vault.adapter.exists(destinationThumbnailPath)) {
            await this.app.vault.adapter.remove(destinationThumbnailPath)
          }

          await this.app.vault.adapter.copy(thumbnailPath, destinationThumbnailPath)
        }
      }

      await Promise.all([
        copyThumbnail(),
        this.app.vault.adapter.write(
          `${this.cacheDir}/${node.id}.metadata.json`,
          JSON.stringify(metadata)
        )
      ])

      state.evaluated = true
      state.cached = true
      state.metadata = metadata

      this.thumbnailCacheIds.add(node.id)
      this.metadataCacheIds.add(node.id)
      this.metadataMemory.set(node.id, metadata)
      this.urlCacheSources.set(normalizedUrl, node.id)
      this.scheduleUrlCacheIndexWrite()
      this.cacheHits++

      node.updateNodeLabel(metadata.title)
      this.applyPreparedNodeState(node, state)
    } catch (error) {
      this.log(error, true)
      this.urlCacheSources.delete(normalizedUrl)
      this.scheduleUrlCacheIndexWrite()
      this.markNodeCacheMiss(node, state)
    }
  }

  private async evaluateNodeCache(node: LinkNode, state: NodeState) {
    try {
      let metadata = this.metadataMemory.get(node.id)

      if (!metadata) {
        const raw = await this.app.vault.adapter.read(`${this.cacheDir}/${node.id}.metadata.json`)
        metadata = JSON.parse(raw) as CacheMetadata
        this.metadataMemory.set(node.id, metadata)
      }

      if (typeof metadata?.title !== 'string') {
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

      if (metadata.url) {
        this.urlCacheSources.set(normalizeCacheUrl(metadata.url), node.id)
        this.scheduleUrlCacheIndexWrite()
      }

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
    this.getNodeState(node).mounted = true
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
    preview.loading = force ? 'eager' : 'lazy'
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

    const activeGeneration = this.activeGenerations.get(node.id)

    if (activeGeneration) {
      activeGeneration.requeue = true
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

    if (this.activeGenerations.has(node.id) || this.queuedGenerationIds.has(node.id)) {
      return
    }

    if (
      this.batchStartedAt === null &&
      this.activeGenerations.size === 0 &&
      this.generationQueue.length === 0
    ) {
      this.batchStartedAt = performance.now()
      this.batchCompleted = 0
    }

    const job: GenerationJob = {
      node,
      enqueuedAt: performance.now(),
      attempt,
      forceNative
    }

    if (front) {
      this.generationQueue.unshift(job)
    } else {
      this.generationQueue.push(job)
    }

    this.queuedGenerationIds.add(node.id)
    this.preemptGenerationForHigherPriority(node)
    this.scheduleThumbnailQueue()
  }

  private preemptGenerationForHigherPriority(node: LinkNode) {
    if (this.activeGenerations.size < this.getGenerationConcurrency()) return

    const newTier = Math.floor(this.getGenerationPriority(node) / 1000)
    let worstSession: ActiveGeneration | null = null
    let worstTier = newTier

    for (const session of this.activeGenerations.values()) {
      const tier = Math.floor(this.getGenerationPriority(session.node) / 1000)

      if (tier > worstTier) {
        worstTier = tier
        worstSession = session
      }
    }

    if (!worstSession) return

    worstSession.requeue = true
    this.cancelGenerationTransport(worstSession)
    worstSession.finish('preempted')
  }

  private preemptForQueuedViewportPriority() {
    if (this.generationQueue.length === 0 || this.activeGenerations.size === 0) return

    const now = performance.now()

    if (now - this.lastViewportRebalanceAt < VIEWPORT_REBALANCE_INTERVAL_MS) return

    this.lastViewportRebalanceAt = now

    let bestQueuedTier = Number.POSITIVE_INFINITY

    for (const job of this.generationQueue) {
      bestQueuedTier = Math.min(
        bestQueuedTier,
        Math.floor(this.getGenerationPriority(job.node) / 1000)
      )
    }

    let worstSession: ActiveGeneration | null = null
    let worstActiveTier = bestQueuedTier

    for (const session of this.activeGenerations.values()) {
      const tier = Math.floor(this.getGenerationPriority(session.node) / 1000)

      if (tier > worstActiveTier) {
        worstActiveTier = tier
        worstSession = session
      }
    }

    if (!worstSession) return

    worstSession.requeue = true
    this.cancelGenerationTransport(worstSession)
    worstSession.finish('preempted')
  }

  private scheduleThumbnailQueue() {
    this.pruneDetachedActiveResources()

    if (!this.activeInteractiveNode) {
      this.preemptForQueuedViewportPriority()
    }

    if (
      this.activeInteractiveNode ||
      this.interactiveTransitionRunning ||
      this.generationQueueScheduled ||
      this.generationQueue.length === 0 ||
      this.activeGenerations.size >= this.getGenerationConcurrency()
    ) {
      this.releaseBackgroundExecutionIfIdle()
      return
    }

    this.ensureBackgroundExecution(this.generationQueue[0].node)
    this.generationQueueScheduled = true

    queueMicrotask(() => {
      this.generationQueueScheduled = false
      this.processThumbnailQueue()
    })
  }

  private processThumbnailQueue() {
    if (this.activeInteractiveNode || this.interactiveTransitionRunning) return

    this.preconnectQueuedWork()

    const concurrency = this.getGenerationConcurrency()

    while (this.activeGenerations.size < concurrency && this.generationQueue.length > 0) {
      const job = this.dequeueNextGenerationJob()

      if (!job) break

      void this.generateQueuedThumbnail(job)
    }

    this.releaseBackgroundExecutionIfIdle()
  }

  private preconnectQueuedWork() {
    if (!this.networkPreconnector || this.generationQueue.length === 0) return

    const candidates = this.generationQueue
      .slice(0, PRECONNECT_QUEUE_SAMPLE_SIZE)
      .sort(
        (left, right) =>
          this.getGenerationPriority(left.node) - this.getGenerationPriority(right.node)
      )
      .map(job => job.node.url)

    this.networkPreconnector.preconnect(candidates, PRECONNECT_LOOKAHEAD_ORIGINS)
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
    this.dequeuedGenerationJobs++

    return job
  }

  private hasFocusedCanvasWindow(): boolean {
    return (this.app.workspace.getLeavesOfType('canvas') as CanvasLeaf[]).some(leaf =>
      leaf.view.containerEl.ownerDocument.hasFocus()
    )
  }

  private getGenerationConcurrency(): number {
    const hardwareConcurrency = navigator.hardwareConcurrency || 4

    if (this.hasFocusedCanvasWindow() || hardwareConcurrency < BACKGROUND_THREE_WORKER_MIN_CORES) {
      return FOREGROUND_GENERATION_CONCURRENCY
    }

    return hardwareConcurrency >= BACKGROUND_FOUR_WORKER_MIN_CORES
      ? HIGH_END_BACKGROUND_GENERATION_CONCURRENCY
      : BACKGROUND_GENERATION_CONCURRENCY
  }

  private getCaptureViewport(node: LinkNode): { width: number; height: number } {
    const width = Math.max(1, node.width ?? 500)
    const height = Math.max(1, node.height ?? 320)
    const longEdge = Math.max(width, height)
    const scale = Math.min(1, THUMBNAIL_MAX_LONG_EDGE / longEdge)

    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    }
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

    const viewportWidth = Math.max(1, viewport.maxX - viewport.minX)
    const viewportHeight = Math.max(1, viewport.maxY - viewport.minY)
    const viewportCenterX = viewport.minX + viewportWidth / 2
    const viewportCenterY = viewport.minY + viewportHeight / 2
    const nodeCenterX = nodeMinX + node.width / 2
    const nodeCenterY = nodeMinY + node.height / 2
    const normalizedDistance = Math.min(
      999,
      Math.hypot(
        (nodeCenterX - viewportCenterX) / viewportWidth,
        (nodeCenterY - viewportCenterY) / viewportHeight
      )
    )

    if (intersects(viewport.minX, viewport.minY, viewport.maxX, viewport.maxY)) {
      return normalizedDistance
    }

    if (
      intersects(
        viewport.minX - viewportWidth,
        viewport.minY - viewportHeight,
        viewport.maxX + viewportWidth,
        viewport.maxY + viewportHeight
      )
    ) {
      return 1000 + normalizedDistance
    }

    return 2000 + normalizedDistance
  }

  private generateQueuedThumbnail(job: GenerationJob): Promise<void> {
    const { node } = job

    return new Promise(resolve => {
      let completed = false
      const captureViewport = this.getCaptureViewport(node)
      const worker =
        job.forceNative || this.dedicatedWorkersDisabled
          ? null
          : (this.captureWorkerPool?.acquire(
              node.nodeEl.ownerDocument,
              captureViewport.width,
              captureViewport.height
            ) ?? null)
      const session: ActiveGeneration = {
        node,
        url: node.url,
        startedAt: performance.now(),
        requeue: false,
        attempt: job.attempt,
        worker,
        finish: () => {}
      }
      const timeoutMs =
        job.attempt === 0 ? GENERATION_FIRST_PASS_TIMEOUT_MS : GENERATION_RETRY_TIMEOUT_MS

      session.finish = outcome => {
        if (completed) return

        completed = true
        window.clearTimeout(timeoutId)

        if (this.activeGenerations.get(node.id) === session) {
          this.activeGenerations.delete(node.id)
        }

        if (session.worker) {
          this.captureWorkerPool?.release(session.worker)
        }

        if (outcome === 'success') {
          this.generationCompleted++
          this.batchCompleted++
          this.generationTotalMs += performance.now() - session.startedAt

          if (session.worker) {
            this.consecutiveDedicatedWorkerFailures = 0
          }
        } else if (outcome === 'timeout') {
          this.generationTimedOut++
        } else if (outcome === 'failure') {
          this.generationFailed++
        } else if (outcome === 'preempted') {
          this.generationPreemptions++
        } else if (outcome === 'worker-fallback') {
          this.dedicatedWorkerFallbacks++
          this.consecutiveDedicatedWorkerFailures++

          if (
            this.consecutiveDedicatedWorkerFailures >= DEDICATED_WORKER_FAILURE_THRESHOLD &&
            !this.dedicatedWorkersDisabled
          ) {
            this.dedicatedWorkersDisabled = true
            this.captureWorkerPool?.disposeIdle()
            this.log(
              'Dedicated capture workers disabled after repeated runtime failures; using native generation fallback.',
              true
            )
          }
        }

        const canRequeue = !this.getNodeState(node).cached && Boolean(node.nodeEl?.isConnected)
        const shouldPriorityRequeue = canRequeue && (session.requeue || outcome === 'stale')
        const shouldRetryTimeout = canRequeue && outcome === 'timeout' && session.attempt === 0
        const shouldFallbackToNative =
          canRequeue && outcome === 'worker-fallback' && Boolean(session.worker)

        resolve()

        if (shouldFallbackToNative) {
          this.enqueueThumbnailGeneration(node, true, session.attempt, true)
        } else if (shouldPriorityRequeue) {
          this.enqueueThumbnailGeneration(node, true, session.attempt)
        } else if (shouldRetryTimeout) {
          this.enqueueThumbnailGeneration(node, false, 1, job.forceNative)
        }

        if (!this.activeInteractiveNode) {
          this.scheduleThumbnailQueue()
        } else {
          this.releaseBackgroundExecutionIfIdle()
        }
      }

      const timeoutId = window.setTimeout(() => {
        this.log(`Thumbnail generation timed out for ${session.url}`, true)
        this.cancelGenerationTransport(session)
        session.finish(session.worker ? 'worker-fallback' : 'timeout')
      }, timeoutMs)

      this.activeGenerations.set(node.id, session)
      this.peakGenerationWorkers = Math.max(this.peakGenerationWorkers, this.activeGenerations.size)

      if (worker) {
        void this.runCaptureWorkerGeneration(session, worker)
        return
      }

      if (!this.ensureNodeContentMounted(node)) {
        session.finish('unmounted')
        return
      }

      this.requestNodeFrame(node, 'generation')
    })
  }

  private async runCaptureWorkerGeneration(session: ActiveGeneration, worker: CaptureWorker) {
    const pool = this.captureWorkerPool

    if (!pool) {
      session.finish('failure')
      return
    }

    try {
      await pool.navigate(worker, session.url)

      if (this.activeGenerations.get(session.node.id) !== session) return

      if (session.domReadyAt === undefined) {
        session.domReadyAt = performance.now()
        this.generationDomReadyTotalMs += session.domReadyAt - session.startedAt
        this.generationDomReadyCount++
      }

      await this.captureGeneratedFrame(session.node, worker.frame, session)
    } catch (error) {
      if (this.activeGenerations.get(session.node.id) !== session) return

      this.log(error, true)
      this.cancelGenerationTransport(session)
      session.finish('worker-fallback')
    }
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
    if (this.activeGenerations.size > 0 || this.generationQueue.length > 0) return

    if (this.batchStartedAt !== null) {
      this.lastBatchDurationMs = performance.now() - this.batchStartedAt
      this.lastBatchCompleted = this.batchCompleted
      this.batchStartedAt = null
      this.batchCompleted = 0
    }

    this.releaseBackgroundExecution()
    this.captureWorkerPool?.disposeIdle()
  }

  private finishActiveGeneration(node: LinkNode, outcome: GenerationOutcome) {
    const session = this.activeGenerations.get(node.id)

    if (!session || session.node !== node) return

    session.finish(outcome)
  }

  private abortActiveGenerations(requeue: boolean) {
    const sessions = [...this.activeGenerations.values()]

    for (const session of sessions) {
      session.requeue = requeue
      this.cancelGenerationTransport(session)
      session.finish('preempted')
    }
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

    if (this.activeInteractiveNode === node) {
      this.removeNodeFrame(node)
      this.clearInteractiveState(node)
    }

    const session = this.activeGenerations.get(node.id)

    if (session?.node === node) {
      this.cancelGenerationTransport(session)
      session.finish('stale')
    }

    void this.prepareNode(node)
  }

  private handleBreakpointUpdate(node: LinkNode) {
    const state = this.getNodeState(node)
    const session = this.activeGenerations.get(node.id)
    const isInteractive = this.activeInteractiveNode === node
    const isNativeGenerating = session?.node === node && !session.worker

    if (!this.isNodeContentMounted(node) && (isInteractive || isNativeGenerating)) {
      this.ensureNodeContentMounted(node)
    }

    const mounted = this.isNodeContentMounted(node)

    if (mounted) {
      const needsFrameRecovery =
        (isNativeGenerating || isInteractive) && node.frameEl?.tagName !== 'WEBVIEW'

      if (state.mounted === true && !needsFrameRecovery) return

      state.mounted = true

      if (isNativeGenerating && node.frameEl?.tagName !== 'WEBVIEW') {
        this.requestNodeFrame(node, 'generation')
      } else if (isInteractive && node.frameEl?.tagName !== 'WEBVIEW') {
        this.requestNodeFrame(node, 'interactive')
      }

      void this.prepareNode(node)
      return
    }

    if (state.mounted === false && !isInteractive && !isNativeGenerating) return

    state.mounted = false

    if (isInteractive) {
      this.removeNodeFrame(node)
      this.clearInteractiveState(node)
    }

    if (isNativeGenerating) {
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

        this.abortActiveGenerations(true)
        this.captureWorkerPool?.disposeIdle()
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

    for (const generation of [...this.activeGenerations.values()]) {
      if (generation.node.nodeEl?.isConnected) continue

      this.cancelGenerationTransport(generation)
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
      } else if (this.activeInteractiveNode === node) {
        this.ensurePreview(node, true)
        this.clearInteractiveState(node)
      }

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
      frameEl.setAudioMuted?.(true)

      frameEl.addEventListener(
        'dom-ready',
        () => {
          const session = this.activeGenerations.get(node.id)

          if (session?.node === node && session.domReadyAt === undefined) {
            session.domReadyAt = performance.now()
            this.generationDomReadyTotalMs += session.domReadyAt - session.startedAt
            this.generationDomReadyCount++
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

    await Promise.allSettled([
      frameEl.insertCSS(LIGHT_THEME_CSS),
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

  private async captureGeneratedFrame(
    node: LinkNode,
    frameEl: CaptureWorkerFrame,
    existingSession?: ActiveGeneration
  ) {
    const session = existingSession ?? this.activeGenerations.get(node.id)

    if (!session || session.node !== node || !this.isGenerationFrameCurrent(session, frameEl)) {
      return
    }

    try {
      await Promise.race([
        frameEl.executeJavaScript(GENERATION_READY_SCRIPT),
        delay(GENERATION_PAINT_TIMEOUT_MS)
      ])
    } catch {
      // Best effort.
    }

    if (!this.isGenerationFrameCurrent(session, frameEl)) return

    if (node.url !== session.url) {
      this.cancelGenerationTransport(session)
      session.finish('stale')
      return
    }

    const title = frameEl.getTitle()
    const saved = await this.saveThumbnailFromFrame(node, frameEl)

    if (!this.isGenerationFrameCurrent(session, frameEl)) return

    if (!saved) {
      this.cancelGenerationTransport(session)
      session.finish(session.worker ? 'worker-fallback' : 'failure')
      return
    }

    if (node.url !== session.url) {
      this.cancelGenerationTransport(session)
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
      await this.app.vault.adapter.write(
        `${this.cacheDir}/${node.id}.metadata.json`,
        JSON.stringify(metadata)
      )
    } catch (error) {
      this.log(error, true)
      this.cancelGenerationTransport(session)
      session.finish('failure')
      return
    }

    if (!this.isGenerationFrameCurrent(session, frameEl)) return

    const state = this.getNodeState(node)

    state.evaluated = true
    state.cached = true
    state.metadata = metadata

    this.thumbnailCacheIds.add(node.id)
    this.metadataCacheIds.add(node.id)
    this.metadataMemory.set(node.id, metadata)
    this.urlCacheSources.set(normalizeCacheUrl(session.url), node.id)
    this.scheduleUrlCacheIndexWrite()

    node.updateNodeLabel(title)

    if (session.worker) {
      this.removePendingPlaceholder(node)

      if (this.isNodeContentMounted(node)) {
        this.ensurePreview(node, true)
      }

      this.log(`Cached link ${node.url}`)
      session.finish('success')
      return
    }

    const previewReady = await this.showPreviewOverFrame(node, false)

    if (!this.isGenerationFrameCurrent(session, frameEl)) return

    if (!previewReady || !this.getNodeState(node).cached) {
      session.requeue = true
      this.cancelGenerationTransport(session)
      session.finish('failure')
      return
    }

    this.removeNodeFrame(node)
    this.log(`Cached link ${node.url}`)
    session.finish('success')
  }

  private optimizeThumbnail(image: ThumbnailImage, node: LinkNode): ThumbnailImage {
    const size = image.getSize()
    const longEdge = Math.max(size.width, size.height)
    const nodeLongEdge =
      typeof node.width === 'number' && typeof node.height === 'number'
        ? Math.max(node.width, node.height)
        : THUMBNAIL_MAX_LONG_EDGE
    const targetLongEdge = Math.min(
      THUMBNAIL_MAX_LONG_EDGE,
      Math.max(THUMBNAIL_MIN_LONG_EDGE, Math.ceil(nodeLongEdge * THUMBNAIL_NODE_SCALE))
    )

    if (longEdge <= targetLongEdge) return image

    const scale = targetLongEdge / longEdge

    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    })
  }

  private async saveThumbnailFromFrame(
    node: LinkNode,
    frameEl: CaptureWorkerFrame
  ): Promise<boolean> {
    if (!frameEl.isConnected) return false

    const startedAt = performance.now()

    try {
      const captureStartedAt = performance.now()
      let image = await frameEl.capturePage()

      if (image.isEmpty() && frameEl.isConnected) {
        await delay(GENERATION_CAPTURE_RETRY_MS)
        image = await frameEl.capturePage()
      }

      this.capturePageTotalMs += performance.now() - captureStartedAt
      frameEl.stop?.()

      if (!frameEl.isConnected || image.isEmpty()) {
        return false
      }

      const encodeStartedAt = performance.now()
      const optimized = this.optimizeThumbnail(image, node)
      const jpeg = optimized.toJPEG(THUMBNAIL_JPEG_QUALITY)
      this.encodeTotalMs += performance.now() - encodeStartedAt

      const writeStartedAt = performance.now()
      await this.app.vault.adapter.writeBinary(`${this.cacheDir}/${node.id}.thumbnail.jpg`, jpeg)
      this.writeTotalMs += performance.now() - writeStartedAt

      this.captureTotalMs += performance.now() - startedAt
      this.capturedThumbnailBytes += jpeg.byteLength

      return true
    } catch (error) {
      this.log(error, true)
      return false
    }
  }

  private async saveThumbnail(node: LinkNode): Promise<boolean> {
    const frameEl = node.frameEl

    if (frameEl?.tagName !== 'WEBVIEW') return false

    return this.saveThumbnailFromFrame(node, frameEl as CaptureWorkerFrame)
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
    this.dedicatedWorkerFallbacks = 0
    this.consecutiveDedicatedWorkerFailures = 0
    this.generationTotalMs = 0
    this.generationDomReadyTotalMs = 0
    this.generationDomReadyCount = 0
    this.queueWaitTotalMs = 0
    this.dequeuedGenerationJobs = 0
    this.peakGenerationWorkers = this.activeGenerations.size
    this.batchStartedAt =
      this.activeGenerations.size > 0 || this.generationQueue.length > 0 ? performance.now() : null
    this.batchCompleted = 0
    this.lastBatchDurationMs = 0
    this.lastBatchCompleted = 0
    this.captureTotalMs = 0
    this.capturePageTotalMs = 0
    this.encodeTotalMs = 0
    this.writeTotalMs = 0
    this.capturedThumbnailBytes = 0
    this.captureWorkerPool?.resetMetrics()
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
    const averageDomReadyMs =
      this.generationDomReadyCount > 0
        ? Math.round(this.generationDomReadyTotalMs / this.generationDomReadyCount)
        : 0
    const averageQueueWaitMs =
      this.dequeuedGenerationJobs > 0
        ? Math.round(this.queueWaitTotalMs / this.dequeuedGenerationJobs)
        : 0
    const averageCapturePageMs =
      this.generationCompleted > 0
        ? Math.round(this.capturePageTotalMs / this.generationCompleted)
        : 0
    const averageEncodeMs =
      this.generationCompleted > 0 ? Math.round(this.encodeTotalMs / this.generationCompleted) : 0
    const averageWriteMs =
      this.generationCompleted > 0 ? Math.round(this.writeTotalMs / this.generationCompleted) : 0
    const lastBatchSeconds = this.lastBatchDurationMs / 1000
    const lastBatchThroughput =
      lastBatchSeconds > 0 ? this.lastBatchCompleted / lastBatchSeconds : 0

    const nativeGenerationFrames = [...this.activeGenerations.values()].filter(
      session => !session.worker
    ).length

    const diagnostics = [
      `Mounted web cards: ${mountedWebCards.size}`,
      `Cached previews: ${cachedPreviews}`,
      `Live Canvas webviews: ${liveWebviews}`,
      `Generating thumbnails: ${this.activeGenerations.size}/${this.getGenerationConcurrency()}`,
      `Dedicated capture workers: ${this.dedicatedWorkersDisabled ? 'disabled' : 'enabled'} (${this.captureWorkerPool?.busyCount ?? 0}/${this.captureWorkerPool?.size ?? 0})`,
      `Capture workers created: ${this.captureWorkerPool?.createdCount ?? 0}`,
      `Capture workers reused: ${this.captureWorkerPool?.reusedCount ?? 0}`,
      `Native generation fallbacks: ${nativeGenerationFrames}`,
      `Queued: ${this.generationQueue.length}`,
      `Interactive webview: ${this.activeInteractiveNode ? 1 : 0}`,
      `Background execution: ${this.backgroundExecution.active ? 'on' : 'off'}`,
      `Network preconnect: ${this.networkPreconnector?.active ? 'on' : 'off'} (${this.networkPreconnector?.count ?? 0})`,
      `Cache hits: ${this.cacheHits}`,
      `Cache misses: ${this.cacheMisses}`,
      `Generated: ${this.generationCompleted}`,
      `Generation failures: ${this.generationFailed}`,
      `Generation timeouts: ${this.generationTimedOut}`,
      `Generation preemptions: ${this.generationPreemptions}`,
      `Dedicated worker fallbacks: ${this.dedicatedWorkerFallbacks}`,
      `Peak generation workers: ${this.peakGenerationWorkers}`,
      `Last batch: ${this.lastBatchCompleted} cards / ${Math.round(this.lastBatchDurationMs)} ms`,
      `Last batch throughput: ${lastBatchThroughput.toFixed(2)} cards/s`,
      `Average queue wait: ${averageQueueWaitMs} ms`,
      `Average DOM ready: ${averageDomReadyMs} ms`,
      `Average generation: ${averageGenerationMs} ms`,
      `Average thumbnail pipeline: ${averageCaptureMs} ms`,
      `Average capturePage: ${averageCapturePageMs} ms`,
      `Average encode: ${averageEncodeMs} ms`,
      `Average write: ${averageWriteMs} ms`,
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

    if (unusedNodeIds.length > 0) {
      const unused = new Set(unusedNodeIds)

      for (const [url, sourceNodeId] of this.urlCacheSources) {
        if (unused.has(sourceNodeId)) {
          this.urlCacheSources.delete(url)
        }
      }

      this.scheduleUrlCacheIndexWrite()
    }

    new Notice(`${unusedNodeIds.length} Unused thumbnails cleaned up!`)
  }

  extractNodeIdsFromCanvas(content: string): string[] {
    const canvas = JSON.parse(content)

    return (canvas.nodes || []).map((node: CanvasNodeData) => node.id)
  }
}
