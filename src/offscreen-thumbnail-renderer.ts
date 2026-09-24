const OFFSCREEN_FRAME_RATE = 60
const OFFSCREEN_RENDER_TIMEOUT_MS = 4500
const OFFSCREEN_PAINT_TIMEOUT_MS = 900
const OFFSCREEN_MIN_WIDTH = 64
const OFFSCREEN_MIN_HEIGHT = 64

const GENERATION_LIGHT_THEME_CSS = `
  :root {
    color-scheme: light !important;
  }
`

const PAINT_READY_SCRIPT = `
  new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve)
    })
  })
`

type OffscreenImage = {
  getSize(): { width: number; height: number }
  isEmpty(): boolean
  resize(options: { width: number; height: number; quality: 'good' }): OffscreenImage
  toJPEG(quality: number): ArrayBuffer
  toBitmap?(): Uint8Array
}

type OffscreenWebContents = {
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
  executeJavaScript(code: string): Promise<unknown>
  insertCSS(css: string): Promise<string>
  getTitle(): string
  setFrameRate?(fps: number): void
  setAudioMuted?(muted: boolean): void
  startPainting?(): void
  stopPainting?(): void
  invalidate?(): void
  isDestroyed?(): boolean
}

type OffscreenBrowserWindow = {
  webContents: OffscreenWebContents
  loadURL(url: string): Promise<void>
  setSize?(width: number, height: number, animate?: boolean): void
  setContentSize?(width: number, height: number, animate?: boolean): void
  destroy(): void
  isDestroyed?(): boolean
}

type BrowserWindowConstructor = new (options: {
  width: number
  height: number
  show: boolean
  useContentSize: boolean
  paintWhenInitiallyHidden: boolean
  backgroundColor: string
  webPreferences: {
    offscreen: boolean
    backgroundThrottling: boolean
    partition?: string
  }
}) => OffscreenBrowserWindow

type ElectronRemoteLike = {
  BrowserWindow?: BrowserWindowConstructor
}

type InternalTask = {
  id: number
  url: string
  width: number
  height: number
  startedAt: number
  cancelled: boolean
  settled: boolean
  resolve: (result: OffscreenRenderResult) => void
  reject: (error: Error) => void
  abort: (() => void) | null
}

type WorkerState = {
  window: OffscreenBrowserWindow | null
  task: InternalTask | null
}

export type OffscreenRenderResult = {
  image: OffscreenImage
  title: string
  totalMs: number
  domReadyMs: number
  themeMs: number
  paintReadyMs: number
}

export type OffscreenRenderTask = {
  startedAt: number
  promise: Promise<OffscreenRenderResult>
  cancel: () => void
}

function getRuntimeRequire(): ((specifier: string) => unknown) | null {
  const runtimeGlobal = globalThis as typeof globalThis & {
    require?: (specifier: string) => unknown
  }

  return typeof runtimeGlobal.require === 'function' ? runtimeGlobal.require : null
}

function resolveBrowserWindowConstructor(): BrowserWindowConstructor | null {
  const runtimeRequire = getRuntimeRequire()

  if (!runtimeRequire) return null

  try {
    const remote = runtimeRequire('@electron/remote') as ElectronRemoteLike
    return remote.BrowserWindow ?? null
  } catch {
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms))
}

function isFatalLoadFailure(args: unknown[]): boolean {
  const errorCode = typeof args[1] === 'number' ? args[1] : 0
  const isMainFrame = typeof args[4] === 'boolean' ? args[4] : true

  if (!isMainFrame) return false

  return errorCode !== -3
}

function imageLooksCompletelyBlack(image: OffscreenImage): boolean {
  const bitmap = image.toBitmap?.()

  if (!bitmap || bitmap.length < 4) return false

  const pixelCount = Math.floor(bitmap.length / 4)
  const sampleCount = Math.min(768, pixelCount)
  const stride = Math.max(1, Math.floor(pixelCount / sampleCount))

  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4

    if (
      (bitmap[offset] ?? 0) > 3 ||
      (bitmap[offset + 1] ?? 0) > 3 ||
      (bitmap[offset + 2] ?? 0) > 3
    ) {
      return false
    }
  }

  return true
}

function isUsableFrame(image: OffscreenImage, width: number, height: number): boolean {
  if (image.isEmpty() || imageLooksCompletelyBlack(image)) return false

  const size = image.getSize()
  const minimumArea = width * height * 0.7

  return size.width > 0 && size.height > 0 && size.width * size.height >= minimumArea
}

export default class OffscreenThumbnailRenderer {
  private readonly BrowserWindow = resolveBrowserWindowConstructor()
  private readonly workers: WorkerState[]
  private readonly pending: InternalTask[] = []
  private nextTaskId = 1
  private disabled = false
  private disabledReason: string | null = null

  constructor(
    private readonly partition: string | null,
    private readonly concurrency = 2
  ) {
    this.workers = Array.from({ length: Math.max(1, concurrency) }, () => ({
      window: null,
      task: null
    }))
  }

  get available(): boolean {
    return this.BrowserWindow !== null && !this.disabled
  }

  get activeCount(): number {
    return this.workers.filter(worker => worker.task !== null).length
  }

  get poolSize(): number {
    return this.workers.length
  }

  get unavailableReason(): string | null {
    if (this.available) return null

    return this.disabledReason ?? 'Electron BrowserWindow is unavailable'
  }

  render(url: string, width: number, height: number): OffscreenRenderTask {
    const startedAt = performance.now()
    let resolveTask: (result: OffscreenRenderResult) => void = () => {}
    let rejectTask: (error: Error) => void = () => {}

    const promise = new Promise<OffscreenRenderResult>((resolve, reject) => {
      resolveTask = resolve
      rejectTask = reject
    })

    const task: InternalTask = {
      id: this.nextTaskId++,
      url,
      width: Math.max(OFFSCREEN_MIN_WIDTH, Math.round(width)),
      height: Math.max(OFFSCREEN_MIN_HEIGHT, Math.round(height)),
      startedAt,
      cancelled: false,
      settled: false,
      resolve: resolveTask,
      reject: rejectTask,
      abort: null
    }

    if (!this.available) {
      task.settled = true
      task.reject(new Error(this.unavailableReason ?? 'Offscreen rendering unavailable'))
    } else {
      this.pending.push(task)
      this.pump()
    }

    return {
      startedAt,
      promise,
      cancel: () => this.cancelTask(task)
    }
  }

  dispose() {
    for (const task of [...this.pending]) {
      this.cancelTask(task)
    }

    for (const worker of this.workers) {
      const task = worker.task

      if (task) {
        this.cancelTask(task)
      }

      this.destroyWorkerWindow(worker)
    }
  }

  private pump() {
    if (!this.available) return

    for (const worker of this.workers) {
      if (worker.task || this.pending.length === 0) continue

      const task = this.pending.shift()

      if (!task || task.cancelled || task.settled) continue

      worker.task = task
      this.startTask(worker, task)
    }
  }

  private cancelTask(task: InternalTask) {
    if (task.settled || task.cancelled) return

    task.cancelled = true

    const pendingIndex = this.pending.indexOf(task)

    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1)
      task.settled = true
      task.reject(new Error('Offscreen render cancelled'))
      return
    }

    task.abort?.()
  }

  private ensureWorkerWindow(
    worker: WorkerState,
    width: number,
    height: number
  ): OffscreenBrowserWindow {
    const existing = worker.window

    if (existing && !existing.isDestroyed?.()) {
      if (existing.setContentSize) {
        existing.setContentSize(width, height, false)
      } else {
        existing.setSize?.(width, height, false)
      }

      return existing
    }

    if (!this.BrowserWindow) {
      throw new Error('Electron BrowserWindow is unavailable')
    }

    const webPreferences: {
      offscreen: boolean
      backgroundThrottling: boolean
      partition?: string
    } = {
      offscreen: true,
      backgroundThrottling: false
    }

    if (this.partition) {
      webPreferences.partition = this.partition
    }

    const created = new this.BrowserWindow({
      width,
      height,
      show: false,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#ffffff',
      webPreferences
    })

    created.webContents.setFrameRate?.(OFFSCREEN_FRAME_RATE)
    created.webContents.setAudioMuted?.(true)
    worker.window = created

    return created
  }

  private startTask(worker: WorkerState, task: InternalTask) {
    let browserWindow: OffscreenBrowserWindow

    try {
      browserWindow = this.ensureWorkerWindow(worker, task.width, task.height)
    } catch (error) {
      this.disable(error)
      this.finishTask(worker, task, null, error)
      return
    }

    const webContents = browserWindow.webContents
    let settled = false
    let domReadyAt = 0
    let themeMs = 0
    let paintReadyStartedAt = 0
    let overallTimeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    let paintTimeoutId: ReturnType<typeof globalThis.setTimeout> | undefined

    const cleanup = () => {
      if (overallTimeoutId !== undefined) {
        globalThis.clearTimeout(overallTimeoutId)
      }

      if (paintTimeoutId !== undefined) {
        globalThis.clearTimeout(paintTimeoutId)
      }
      webContents.removeListener('dom-ready', onDomReady)
      webContents.removeListener('did-fail-load', onDidFailLoad)
      webContents.removeListener('render-process-gone', onRenderProcessGone)
      webContents.removeListener('paint', onPaint)
      task.abort = null
    }

    const fail = (error: Error, destroyWindow = false) => {
      if (settled) return

      settled = true
      cleanup()

      if (destroyWindow) {
        this.destroyWorkerWindow(worker)
      } else {
        webContents.stopPainting?.()
      }

      this.finishTask(worker, task, null, error)
    }

    const succeed = (image: OffscreenImage) => {
      if (settled) return

      settled = true
      cleanup()
      webContents.stopPainting?.()

      this.finishTask(worker, task, {
        image,
        title: webContents.getTitle(),
        totalMs: performance.now() - task.startedAt,
        domReadyMs: domReadyAt > 0 ? domReadyAt - task.startedAt : 0,
        themeMs,
        paintReadyMs: paintReadyStartedAt > 0 ? performance.now() - paintReadyStartedAt : 0
      })
    }

    const onPaint = (...args: unknown[]) => {
      if (paintReadyStartedAt === 0 || task.cancelled) return

      const image = args[2] as OffscreenImage | undefined

      if (!image || !isUsableFrame(image, task.width, task.height)) return

      succeed(image)
    }

    const onDidFailLoad = (...args: unknown[]) => {
      if (!isFatalLoadFailure(args)) return

      const code = typeof args[1] === 'number' ? args[1] : 0
      const description = typeof args[2] === 'string' ? args[2] : 'unknown error'

      fail(new Error(`Offscreen load failed (${code}): ${description}`), true)
    }

    const onRenderProcessGone = () => {
      fail(new Error('Offscreen renderer process exited'), true)
    }

    const onDomReady = () => {
      void (async () => {
        if (settled || task.cancelled) return

        domReadyAt = performance.now()
        const themeStartedAt = performance.now()

        try {
          await webContents.insertCSS(GENERATION_LIGHT_THEME_CSS)
        } catch {
          // Theme injection is best effort.
        }

        themeMs = performance.now() - themeStartedAt

        try {
          await Promise.race([webContents.executeJavaScript(PAINT_READY_SCRIPT), delay(120)])
        } catch {
          // Paint readiness is best effort.
        }

        if (settled || task.cancelled) return

        paintReadyStartedAt = performance.now()
        webContents.startPainting?.()
        webContents.invalidate?.()

        paintTimeoutId = globalThis.setTimeout(() => {
          fail(new Error('Offscreen paint timed out'), true)
        }, OFFSCREEN_PAINT_TIMEOUT_MS)
      })()
    }

    task.abort = () => {
      fail(new Error('Offscreen render cancelled'), true)
    }

    webContents.on('dom-ready', onDomReady)
    webContents.on('did-fail-load', onDidFailLoad)
    webContents.on('render-process-gone', onRenderProcessGone)
    webContents.on('paint', onPaint)

    webContents.startPainting?.()

    overallTimeoutId = globalThis.setTimeout(() => {
      fail(new Error('Offscreen render timed out'), true)
    }, OFFSCREEN_RENDER_TIMEOUT_MS)

    void browserWindow.loadURL(task.url).catch(error => {
      fail(error instanceof Error ? error : new Error(String(error)), true)
    })
  }

  private finishTask(
    worker: WorkerState,
    task: InternalTask,
    result: OffscreenRenderResult | null,
    error?: unknown
  ) {
    if (task.settled) return

    task.settled = true

    if (worker.task === task) {
      worker.task = null
    }

    if (result) {
      task.resolve(result)
    } else {
      task.reject(
        error instanceof Error ? error : new Error(String(error ?? 'Offscreen render failed'))
      )
    }

    this.pump()
  }

  private disable(error: unknown) {
    this.disabled = true
    this.disabledReason = error instanceof Error ? error.message : String(error)

    for (const task of [...this.pending]) {
      if (task.settled) continue

      task.settled = true
      task.reject(new Error(this.disabledReason))
    }

    this.pending.length = 0
  }

  private destroyWorkerWindow(worker: WorkerState) {
    const browserWindow = worker.window

    worker.window = null

    if (!browserWindow || browserWindow.isDestroyed?.()) return

    try {
      browserWindow.destroy()
    } catch {
      // Best effort cleanup.
    }
  }
}
