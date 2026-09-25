import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import {
  freemem,
  homedir,
  constants as osConstants,
  platform,
  setPriority,
  tmpdir,
  totalmem
} from 'node:os'
import { join } from 'node:path'
import { buildTuningCandidates, calculateLivePoolSize } from './core-utils'

const BROWSER_START_TIMEOUT_MS = 6000
const CDP_COMMAND_TIMEOUT_MS = 3500
const NAVIGATION_TIMEOUT_MS = 5000
const PAINT_READY_TIMEOUT_MS = 250
const IDLE_SHUTDOWN_MS = 2500
const MIN_SCREENSHOT_BYTES = 512
const LOCAL_BROWSER_MAX_WORKERS = 8
const LOCAL_BROWSER_MEMORY_RESERVE_GIB = 2
const LOCAL_BROWSER_MEMORY_PER_WORKER_GIB = 1.75

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

type BrowserCandidate = {
  name: string
  executablePath: string
}

type CdpResponseError = {
  code?: number
  message?: string
}

type CdpMessage = {
  id?: number
  method?: string
  sessionId?: string
  result?: unknown
  error?: CdpResponseError
  params?: unknown
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeoutId: number
}

type EventWaiter = {
  method: string
  sessionId?: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeoutId: number
}

type BrowserRuntime = {
  process: ChildProcess
  connection: CdpConnection
  profileDir: string
  candidate: BrowserCandidate
}

export type LocalBrowserRenderResult = {
  jpeg: ArrayBuffer
  title: string
  totalMs: number
  navigationMs: number
  paintReadyMs: number
  screenshotMs: number
}

export type LocalBrowserRenderTask = {
  startedAt: number
  promise: Promise<LocalBrowserRenderResult>
  cancel: () => void
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function addCandidate(
  candidates: BrowserCandidate[],
  seen: Set<string>,
  name: string,
  executablePath: string | undefined
) {
  if (!executablePath || seen.has(executablePath) || !existsSync(executablePath)) return

  seen.add(executablePath)
  candidates.push({ name, executablePath })
}

function findOnPath(command: string): string | null {
  try {
    const result = execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    return result || null
  } catch {
    return null
  }
}

function detectBrowserCandidates(): BrowserCandidate[] {
  const candidates: BrowserCandidate[] = []
  const seen = new Set<string>()
  const currentPlatform = platform()

  if (currentPlatform === 'win32') {
    const programFiles = process.env.ProgramFiles
    const programFilesX86 = process.env['ProgramFiles(x86)']
    const localAppData = process.env.LOCALAPPDATA

    addCandidate(
      candidates,
      seen,
      'Microsoft Edge',
      programFilesX86
        ? join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Microsoft Edge',
      programFiles
        ? join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Microsoft Edge',
      localAppData
        ? join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Google Chrome',
      localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Google Chrome',
      programFiles ? join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Google Chrome',
      programFilesX86
        ? join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Brave',
      programFiles
        ? join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Brave',
      localAppData
        ? join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        : undefined
    )

    return candidates
  }

  if (currentPlatform === 'darwin') {
    const userApplications = join(homedir(), 'Applications')

    for (const root of ['/Applications', userApplications]) {
      addCandidate(
        candidates,
        seen,
        'Google Chrome',
        join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
      )
      addCandidate(
        candidates,
        seen,
        'Microsoft Edge',
        join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge')
      )
      addCandidate(
        candidates,
        seen,
        'Brave',
        join(root, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser')
      )
      addCandidate(
        candidates,
        seen,
        'Chromium',
        join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      )
    }

    return candidates
  }

  const linuxCommands: Array<[string, string]> = [
    ['Google Chrome', 'google-chrome-stable'],
    ['Google Chrome', 'google-chrome'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'],
    ['Microsoft Edge', 'microsoft-edge-stable'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Brave', 'brave-browser']
  ]

  for (const [name, command] of linuxCommands) {
    addCandidate(candidates, seen, name, findOnPath(command) ?? undefined)
  }

  return candidates
}

class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly eventWaiters = new Set<EventWaiter>()
  private incomingBuffer = ''
  private closed = false

  constructor(
    private readonly outgoing: NodeJS.WritableStream,
    private readonly incoming: NodeJS.ReadableStream
  ) {
    incoming.on('data', this.onData)
    incoming.on('end', this.onClosed)
    incoming.on('close', this.onClosed)
    incoming.on('error', this.onClosed)
    outgoing.on('error', this.onClosed)
  }

  get isOpen(): boolean {
    return !this.closed
  }

  send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS
  ): Promise<T> {
    if (!this.isOpen) {
      return Promise.reject(new Error('Local browser DevTools pipe is not open'))
    }

    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeoutId
      })

      const message: {
        id: number
        method: string
        params: Record<string, unknown>
        sessionId?: string
      } = {
        id,
        method,
        params
      }

      if (sessionId) {
        message.sessionId = sessionId
      }

      try {
        this.outgoing.write(`${JSON.stringify(message)}\x00`)
      } catch (error) {
        this.pending.delete(id)
        window.clearTimeout(timeoutId)
        reject(toError(error))
      }
    })
  }

  waitForEvent<T>(
    method: string,
    sessionId?: string,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS
  ): Promise<T> {
    if (!this.isOpen) {
      return Promise.reject(new Error('Local browser DevTools pipe is not open'))
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: EventWaiter = {
        method,
        sessionId,
        resolve: value => resolve(value as T),
        reject,
        timeoutId: 0
      }

      waiter.timeoutId = window.setTimeout(() => {
        this.eventWaiters.delete(waiter)
        reject(new Error(`CDP event timed out: ${method}`))
      }, timeoutMs)

      this.eventWaiters.add(waiter)
    })
  }

  close() {
    if (this.closed) return

    this.closed = true
    this.detach()
    this.rejectAll(new Error('Local browser DevTools pipe closed'))
  }

  private readonly onData = (chunk: unknown) => {
    if (this.closed) return

    this.incomingBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)

    let separatorIndex = this.incomingBuffer.indexOf('\x00')

    while (separatorIndex >= 0) {
      const rawMessage = this.incomingBuffer.slice(0, separatorIndex)
      this.incomingBuffer = this.incomingBuffer.slice(separatorIndex + 1)

      if (rawMessage) {
        this.handleMessage(rawMessage)
      }

      separatorIndex = this.incomingBuffer.indexOf('\x00')
    }

    if (this.incomingBuffer.length > 4_000_000) {
      this.close()
    }
  }

  private readonly onClosed = () => {
    if (this.closed) return

    this.closed = true
    this.detach()
    this.rejectAll(new Error('Local browser DevTools pipe closed'))
  }

  private handleMessage(rawMessage: string) {
    let message: CdpMessage

    try {
      message = JSON.parse(rawMessage) as CdpMessage
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)

      if (!pending) return

      this.pending.delete(message.id)
      window.clearTimeout(pending.timeoutId)

      if (message.error) {
        pending.reject(
          new Error(
            `CDP command failed (${message.error.code ?? 'unknown'}): ${
              message.error.message ?? 'unknown error'
            }`
          )
        )
      } else {
        pending.resolve(message.result)
      }

      return
    }

    if (!message.method) return

    for (const waiter of [...this.eventWaiters]) {
      if (waiter.method !== message.method) continue
      if (waiter.sessionId !== undefined && waiter.sessionId !== message.sessionId) continue

      this.eventWaiters.delete(waiter)
      window.clearTimeout(waiter.timeoutId)
      waiter.resolve(message.params)
    }
  }

  private detach() {
    this.incoming.removeListener('data', this.onData)
    this.incoming.removeListener('end', this.onClosed)
    this.incoming.removeListener('close', this.onClosed)
    this.incoming.removeListener('error', this.onClosed)
    this.outgoing.removeListener('error', this.onClosed)
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId)
      pending.reject(error)
    }

    this.pending.clear()

    for (const waiter of this.eventWaiters) {
      window.clearTimeout(waiter.timeoutId)
      waiter.reject(error)
    }

    this.eventWaiters.clear()
  }
}

export default class LocalBrowserRenderer {
  private readonly candidates = detectBrowserCandidates()
  private browser: BrowserRuntime | null = null
  private launchPromise: Promise<BrowserRuntime> | null = null
  private closePromise: Promise<void> | null = null
  private idleTimer = 0
  private disposed = false
  private disabledReason: string | null = null
  private activeTasks = 0
  private readonly activeCancels = new Set<() => void>()

  private browserLaunches = 0
  private browserCloses = 0
  private browserLaunchFailures = 0
  private browserLaunchTotalMs = 0
  private renderFailures = 0
  private renderTotalMs = 0
  private renderCount = 0
  private navigationTotalMs = 0
  private screenshotTotalMs = 0

  private readonly logicalCpuCount = Math.max(1, navigator.hardwareConcurrency || 4)
  private readonly totalMemoryGiB = totalmem() / 1024 ** 3
  private readonly cpuConcurrencyLimit = Math.max(1, Math.floor(this.logicalCpuCount * 0.75))
  private readonly memoryConcurrencyLimit = Math.max(
    1,
    Math.floor(
      Math.max(0, this.totalMemoryGiB - LOCAL_BROWSER_MEMORY_RESERVE_GIB) /
        LOCAL_BROWSER_MEMORY_PER_WORKER_GIB
    )
  )

  readonly maxPoolSize = Math.max(
    1,
    Math.min(LOCAL_BROWSER_MAX_WORKERS, this.cpuConcurrencyLimit, this.memoryConcurrencyLimit)
  )

  readonly heuristicPoolSize = Math.max(
    1,
    Math.min(this.maxPoolSize, Math.ceil(this.logicalCpuCount * 0.625))
  )

  private targetPoolSize = this.heuristicPoolSize

  get available(): boolean {
    return !this.disposed && this.disabledReason === null && this.candidates.length > 0
  }

  get browserName(): string {
    return this.browser?.candidate.name ?? this.candidates[0]?.name ?? 'none'
  }

  get browserPath(): string | null {
    return this.browser?.candidate.executablePath ?? this.candidates[0]?.executablePath ?? null
  }

  get state(): string {
    if (!this.available) return 'unavailable'
    if (this.launchPromise) return 'starting'
    if (this.browser) return this.activeTasks > 0 ? 'active' : 'idle'

    return 'closed'
  }

  get unavailableReason(): string | null {
    if (this.available) return null

    return this.disabledReason ?? 'No supported local Chromium browser was found'
  }

  get activeCount(): number {
    return this.activeTasks
  }

  get poolSize(): number {
    return calculateLivePoolSize(
      this.targetPoolSize,
      this.maxPoolSize,
      freemem() / 1024 ** 3,
      LOCAL_BROWSER_MEMORY_RESERVE_GIB,
      LOCAL_BROWSER_MEMORY_PER_WORKER_GIB
    )
  }

  get tuningKey(): string {
    return `${platform()}|${this.logicalCpuCount}cpu|${Math.round(this.totalMemoryGiB)}gib`
  }

  get hardwareSummary(): string {
    return `${this.logicalCpuCount} logical CPUs / ${this.totalMemoryGiB.toFixed(1)} GiB RAM`
  }

  get tuningCandidates(): number[] {
    return buildTuningCandidates(this.maxPoolSize, this.heuristicPoolSize)
  }

  get concurrencySummary(): string {
    return `${this.poolSize} active / ${this.maxPoolSize} hardware cap / ${this.heuristicPoolSize} heuristic`
  }

  setPoolSize(value: number) {
    this.targetPoolSize = Math.max(1, Math.min(this.maxPoolSize, Math.round(value)))
  }

  get launchCount(): number {
    return this.browserLaunches
  }

  get closeCount(): number {
    return this.browserCloses
  }

  get launchFailureCount(): number {
    return this.browserLaunchFailures
  }

  get renderFailureCount(): number {
    return this.renderFailures
  }

  get averageLaunchMs(): number {
    return this.browserLaunches > 0
      ? Math.round(this.browserLaunchTotalMs / this.browserLaunches)
      : 0
  }

  get averageRenderMs(): number {
    return this.renderCount > 0 ? Math.round(this.renderTotalMs / this.renderCount) : 0
  }

  get averageNavigationMs(): number {
    return this.renderCount > 0 ? Math.round(this.navigationTotalMs / this.renderCount) : 0
  }

  get averageScreenshotMs(): number {
    return this.renderCount > 0 ? Math.round(this.screenshotTotalMs / this.renderCount) : 0
  }

  resetMetrics() {
    this.browserLaunches = 0
    this.browserCloses = 0
    this.browserLaunchFailures = 0
    this.browserLaunchTotalMs = 0
    this.renderFailures = 0
    this.renderTotalMs = 0
    this.renderCount = 0
    this.navigationTotalMs = 0
    this.screenshotTotalMs = 0
  }

  render(url: string, width: number, height: number): LocalBrowserRenderTask {
    const startedAt = performance.now()
    let cancelled = false
    let targetId: string | null = null
    let runtime: BrowserRuntime | null = null

    const cancel = () => {
      if (cancelled) return

      cancelled = true

      if (runtime && targetId) {
        void runtime.connection
          .send('Target.closeTarget', { targetId }, undefined, 1000)
          .catch(() => {})
      }
    }

    this.activeCancels.add(cancel)
    this.cancelIdleShutdown()
    this.activeTasks++

    const promise = (async (): Promise<LocalBrowserRenderResult> => {
      try {
        runtime = await this.ensureBrowser()

        if (cancelled) {
          throw new Error('Local browser render cancelled')
        }

        const target = await runtime.connection.send<{ targetId: string }>('Target.createTarget', {
          url: 'about:blank'
        })
        targetId = target.targetId

        const attached = await runtime.connection.send<{ sessionId: string }>(
          'Target.attachToTarget',
          {
            targetId,
            flatten: true
          }
        )
        const sessionId = attached.sessionId
        const safeWidth = Math.max(64, Math.round(width))
        const safeHeight = Math.max(64, Math.round(height))

        await Promise.all([
          runtime.connection.send('Page.enable', {}, sessionId),
          runtime.connection.send('Runtime.enable', {}, sessionId),
          runtime.connection.send(
            'Emulation.setDeviceMetricsOverride',
            {
              width: safeWidth,
              height: safeHeight,
              deviceScaleFactor: 1,
              mobile: false,
              screenWidth: safeWidth,
              screenHeight: safeHeight
            },
            sessionId
          ),
          runtime.connection.send(
            'Emulation.setEmulatedMedia',
            {
              media: 'screen',
              features: [{ name: 'prefers-color-scheme', value: 'light' }]
            },
            sessionId
          )
        ])

        const domReady = runtime.connection.waitForEvent(
          'Page.domContentEventFired',
          sessionId,
          NAVIGATION_TIMEOUT_MS
        )
        const navigationStartedAt = performance.now()
        const navigation = await runtime.connection.send<{ errorText?: string }>(
          'Page.navigate',
          { url },
          sessionId,
          NAVIGATION_TIMEOUT_MS
        )

        if (navigation.errorText) {
          throw new Error(`Local browser navigation failed: ${navigation.errorText}`)
        }

        await domReady

        if (cancelled) {
          throw new Error('Local browser render cancelled')
        }

        const navigationMs = performance.now() - navigationStartedAt
        const paintStartedAt = performance.now()

        await Promise.race([
          runtime.connection.send(
            'Runtime.evaluate',
            {
              expression: LIGHT_THEME_SCRIPT,
              awaitPromise: true,
              returnByValue: true
            },
            sessionId,
            PAINT_READY_TIMEOUT_MS + 100
          ),
          delay(PAINT_READY_TIMEOUT_MS)
        ]).catch(() => {})

        const paintReadyMs = performance.now() - paintStartedAt

        if (cancelled) {
          throw new Error('Local browser render cancelled')
        }

        const titleResponse = await runtime.connection
          .send<{
            result?: {
              value?: unknown
            }
          }>(
            'Runtime.evaluate',
            {
              expression: 'document.title || location.hostname || location.href',
              returnByValue: true
            },
            sessionId
          )
          .catch(() => ({ result: { value: '' } }))

        const screenshotStartedAt = performance.now()
        const screenshot = await runtime.connection.send<{ data: string }>(
          'Page.captureScreenshot',
          {
            format: 'jpeg',
            quality: 76,
            fromSurface: true,
            captureBeyondViewport: false
          },
          sessionId,
          CDP_COMMAND_TIMEOUT_MS
        )
        const screenshotMs = performance.now() - screenshotStartedAt

        const bytes = Buffer.from(screenshot.data, 'base64')

        if (bytes.byteLength < MIN_SCREENSHOT_BYTES) {
          throw new Error('Local browser returned an empty screenshot')
        }

        const jpeg = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        const totalMs = performance.now() - startedAt

        this.renderCount++
        this.renderTotalMs += totalMs
        this.navigationTotalMs += navigationMs
        this.screenshotTotalMs += screenshotMs

        return {
          jpeg,
          title: typeof titleResponse.result?.value === 'string' ? titleResponse.result.value : '',
          totalMs,
          navigationMs,
          paintReadyMs,
          screenshotMs
        }
      } catch (error) {
        if (!cancelled) {
          this.renderFailures++
        }

        throw error
      } finally {
        if (runtime && targetId) {
          await runtime.connection
            .send('Target.closeTarget', { targetId }, undefined, 1000)
            .catch(() => {})
        }

        this.activeCancels.delete(cancel)
        this.activeTasks = Math.max(0, this.activeTasks - 1)
        this.scheduleIdleShutdown()
      }
    })()

    return {
      startedAt,
      promise,
      cancel
    }
  }

  dispose() {
    if (this.disposed) return

    this.disposed = true
    this.cancelIdleShutdown()

    for (const cancel of [...this.activeCancels]) {
      cancel()
    }

    void this.closeBrowser()
  }

  private ensureBrowser(): Promise<BrowserRuntime> {
    if (this.disposed) {
      return Promise.reject(new Error('Local browser renderer is disposed'))
    }

    if (this.browser?.connection.isOpen && this.browser.process.exitCode === null) {
      return Promise.resolve(this.browser)
    }

    if (this.launchPromise) return this.launchPromise

    this.launchPromise = (async () => {
      if (this.closePromise) {
        await this.closePromise
      }

      const errors: string[] = []

      for (const candidate of this.candidates) {
        if (this.disposed) {
          throw new Error('Local browser renderer is disposed')
        }

        try {
          const runtime = await this.launchCandidate(candidate)

          if (this.disposed) {
            this.browser = runtime
            await this.closeBrowser()
            throw new Error('Local browser renderer is disposed')
          }

          this.browser = runtime
          this.disabledReason = null

          return runtime
        } catch (error) {
          if (this.disposed) {
            throw toError(error)
          }

          this.browserLaunchFailures++
          errors.push(`${candidate.name}: ${toError(error).message}`)
        }
      }

      this.disabledReason =
        errors.length > 0
          ? `Unable to start a supported local browser (${errors.join('; ')})`
          : 'No supported local Chromium browser was found'

      throw new Error(this.disabledReason)
    })().finally(() => {
      this.launchPromise = null
    })

    return this.launchPromise
  }

  private async launchCandidate(candidate: BrowserCandidate): Promise<BrowserRuntime> {
    const launchStartedAt = performance.now()
    const profileDir = mkdtempSync(join(tmpdir(), 'canvas-web-optimizer-'))
    const args = [
      '--headless',
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=896,896',
      'about:blank'
    ]

    const child = spawn(candidate.executablePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
    })

    if (child.pid) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        // Best effort. The adaptive pool still bounds resource usage.
      }
    }

    try {
      const pipeWrite = child.stdio[3] as NodeJS.WritableStream | null
      const pipeRead = child.stdio[4] as NodeJS.ReadableStream | null

      if (!pipeWrite || !pipeRead) {
        throw new Error('Local browser did not expose DevTools pipes')
      }

      const connection = new CdpConnection(pipeWrite, pipeRead)

      await connection.send('Browser.getVersion', {}, undefined, BROWSER_START_TIMEOUT_MS)

      const runtime: BrowserRuntime = {
        process: child,
        connection,
        profileDir,
        candidate
      }

      child.once('exit', () => {
        if (this.browser?.process === child) {
          this.browser.connection.close()
          this.browser = null
        }

        this.cleanupProfile(profileDir)
      })

      this.browserLaunches++
      this.browserLaunchTotalMs += performance.now() - launchStartedAt

      return runtime
    } catch (error) {
      try {
        child.kill()
      } catch {
        // Best effort.
      }

      this.cleanupProfile(profileDir)
      throw error
    }
  }

  private scheduleIdleShutdown() {
    if (this.disposed || this.activeTasks > 0 || !this.browser) return

    this.cancelIdleShutdown()

    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = 0
      void this.closeBrowser()
    }, IDLE_SHUTDOWN_MS)
  }

  private cancelIdleShutdown() {
    if (!this.idleTimer) return

    window.clearTimeout(this.idleTimer)
    this.idleTimer = 0
  }

  private closeBrowser(): Promise<void> {
    if (this.closePromise) return this.closePromise

    const runtime = this.browser

    if (!runtime) return Promise.resolve()

    this.browser = null
    this.cancelIdleShutdown()

    this.closePromise = (async () => {
      try {
        await runtime.connection.send('Browser.close', {}, undefined, 1000).catch(() => {})
      } finally {
        runtime.connection.close()

        await Promise.race([
          new Promise<void>(resolve => {
            if (runtime.process.exitCode !== null) {
              resolve()
              return
            }

            runtime.process.once('exit', () => resolve())
          }),
          delay(1000)
        ])

        if (runtime.process.exitCode === null) {
          try {
            runtime.process.kill()
          } catch {
            // Best effort.
          }
        }

        this.cleanupProfile(runtime.profileDir)
        this.browserCloses++
      }
    })().finally(() => {
      this.closePromise = null
    })

    return this.closePromise
  }

  private cleanupProfile(profileDir: string) {
    try {
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      })
    } catch {
      window.setTimeout(() => {
        try {
          rmSync(profileDir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100
          })
        } catch {
          // OS temp cleanup can remove any remaining files later.
        }
      }, 500)
    }
  }
}
