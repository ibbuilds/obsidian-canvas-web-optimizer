import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { freemem, constants as osConstants, platform, setPriority, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { buildTuningCandidates, calculateLivePoolSize } from '../core-utils'
import { LIGHT_THEME_SCRIPT } from '../web-theme'
import { type BrowserCandidate, detectBrowserCandidates } from './browser-discovery'
import CdpConnection from './cdp-connection'

const BROWSER_START_TIMEOUT_MS = 6000
const CDP_COMMAND_TIMEOUT_MS = 3500
const NAVIGATION_TIMEOUT_MS = 5000
const DOCUMENT_READY_PROBE_INTERVAL_MS = 50
const DOCUMENT_READY_PROBE_COMMAND_TIMEOUT_MS = 600
const PAINT_READY_TIMEOUT_MS = 250
const VISUAL_SETTLE_MIN_MS = 280
const VISUAL_SETTLE_QUIET_MS = 140
const VISUAL_SETTLE_MAX_MS = 900
const VISUAL_SETTLE_COMMAND_TIMEOUT_MS = 1400
const IDLE_SHUTDOWN_MS = 2500
const MIN_SCREENSHOT_BYTES = 512
const LOCAL_BROWSER_MAX_WORKERS = 8
const LOCAL_BROWSER_MEMORY_RESERVE_GIB = 2
const LOCAL_BROWSER_MEMORY_PER_WORKER_GIB = 1.75

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

function isUnsupportedScreenshotSpeedOption(error: unknown): boolean {
  const message = toError(error).message.toLowerCase()

  return (
    message.includes('optimizeforspeed') ||
    message.includes('invalid parameter') ||
    message.includes('invalid params')
  )
}

const COOKIE_CLEANUP_SCRIPT = `
  (() => {
    const rejectSelectors = [
      '#onetrust-reject-all-handler',
      '#CybotCookiebotDialogBodyButtonDecline',
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
      '#didomi-notice-disagree-button',
      '.didomi-continue-without-agreeing',
      '#uc-btn-deny-banner',
      '[data-testid="uc-deny-all-button"]',
      '.iubenda-cs-reject-btn'
    ]
    const knownContainers = [
      '#onetrust-banner-sdk',
      '#onetrust-consent-sdk',
      '#CybotCookiebotDialog',
      '#CybotCookiebotDialogBodyUnderlay',
      '#didomi-host',
      '.qc-cmp2-container',
      '.truste_popframe',
      '#usercentrics-root',
      '.iubenda-cs-container'
    ]
    let actions = 0

    for (const selector of rejectSelectors) {
      const element = document.querySelector(selector)

      if (element instanceof HTMLElement && element.getClientRects().length > 0) {
        element.click()
        actions++
        break
      }
    }

    if (actions === 0) {
      for (const selector of knownContainers) {
        for (const element of document.querySelectorAll(selector)) {
          if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) continue

          element.style.setProperty('display', 'none', 'important')
          element.style.setProperty('visibility', 'hidden', 'important')
          actions++
        }
      }

      const genericDialogs = document.querySelectorAll(
        '[role="dialog"][id*="cookie" i], [role="dialog"][class*="cookie" i], ' +
          '[role="dialog"][id*="consent" i], [role="dialog"][class*="consent" i]'
      )

      for (const element of genericDialogs) {
        if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) continue

        const style = getComputedStyle(element)

        if (style.position !== 'fixed' && style.position !== 'sticky') continue
        if ((element.textContent?.length ?? 0) > 5000) continue

        element.style.setProperty('display', 'none', 'important')
        element.style.setProperty('visibility', 'hidden', 'important')
        actions++
      }
    }

    if (actions > 0) {
      document.documentElement.style.removeProperty('overflow')
      document.body?.style.removeProperty('overflow')
    }

    return actions
  })()
`

const VISUAL_SETTLE_SCRIPT = `
  new Promise(resolve => {
    const startedAt = performance.now()
    let lastActivityAt = startedAt
    let finished = false
    const root = document.documentElement || document
    const markActivity = () => {
      lastActivityAt = performance.now()
    }
    const observer = new MutationObserver(markActivity)

    try {
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true
      })
    } catch {}

    addEventListener('load', markActivity, true)

    const visibleImagesReady = () => {
      for (const image of document.images) {
        const rect = image.getBoundingClientRect()

        if (
          rect.bottom < 0 ||
          rect.right < 0 ||
          rect.top > innerHeight ||
          rect.left > innerWidth ||
          rect.width <= 0 ||
          rect.height <= 0
        ) {
          continue
        }

        if (!image.complete || image.naturalWidth <= 0) {
          return false
        }
      }

      return true
    }

    const finiteAnimationsRunning = () => {
      if (typeof document.getAnimations !== 'function') return false

      return document.getAnimations().some(animation => {
        if (animation.playState !== 'running') return false

        try {
          const timing = animation.effect?.getComputedTiming()
          return Boolean(timing && Number.isFinite(timing.endTime) && timing.endTime > 0)
        } catch {
          return false
        }
      })
    }

    const finish = maxedOut => {
      if (finished) return

      finished = true
      observer.disconnect()
      removeEventListener('load', markActivity, true)

      if (typeof document.getAnimations === 'function') {
        for (const animation of document.getAnimations()) {
          try {
            if (animation.playState !== 'running') continue

            const timing = animation.effect?.getComputedTiming()

            if (timing && Number.isFinite(timing.endTime) && timing.endTime > 0) {
              animation.finish()
            } else {
              animation.pause()
            }
          } catch {
            try {
              animation.pause()
            } catch {}
          }
        }
      }

      let freezeStyle = document.getElementById('canvas-web-optimizer-capture-freeze')

      if (!(freezeStyle instanceof HTMLStyleElement)) {
        freezeStyle = document.createElement('style')
        freezeStyle.id = 'canvas-web-optimizer-capture-freeze'
        freezeStyle.textContent =
          '*, *::before, *::after {' +
          'transition-property: none !important;' +
          'caret-color: transparent !important;' +
          '}'
        document.head?.appendChild(freezeStyle)
      }

      resolve({
        waitedMs: performance.now() - startedAt,
        maxedOut,
        title: document.title || location.hostname || location.href
      })
    }

    const tick = () => {
      const now = performance.now()
      const elapsed = now - startedAt
      const quietFor = now - lastActivityAt
      const fontsReady = !document.fonts || document.fonts.status !== 'loading'
      const ready =
        elapsed >= ${VISUAL_SETTLE_MIN_MS} &&
        quietFor >= ${VISUAL_SETTLE_QUIET_MS} &&
        fontsReady &&
        visibleImagesReady() &&
        !finiteAnimationsRunning()

      if (ready) {
        finish(false)
        return
      }

      if (elapsed >= ${VISUAL_SETTLE_MAX_MS}) {
        finish(true)
        return
      }

      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  })
`

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
  private setupTotalMs = 0
  private setupCount = 0
  private navigationTotalMs = 0
  private navigationReadinessProbeWins = 0
  private paintReadyTotalMs = 0
  private paintReadyCount = 0
  private visualSettleTotalMs = 0
  private visualSettleCount = 0
  private visualSettleMaxOuts = 0
  private cookieCleanupActions = 0
  private screenshotTotalMs = 0
  private screenshotOptimizeForSpeed: boolean | null = null
  private lastRenderFailure = 'none'

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

  get averageSetupMs(): number {
    return this.setupCount > 0 ? Math.round(this.setupTotalMs / this.setupCount) : 0
  }

  get averageNavigationMs(): number {
    return this.renderCount > 0 ? Math.round(this.navigationTotalMs / this.renderCount) : 0
  }

  get readinessProbeWinCount(): number {
    return this.navigationReadinessProbeWins
  }

  get averagePaintReadyMs(): number {
    return this.paintReadyCount > 0 ? Math.round(this.paintReadyTotalMs / this.paintReadyCount) : 0
  }

  get averageVisualSettleMs(): number {
    return this.visualSettleCount > 0
      ? Math.round(this.visualSettleTotalMs / this.visualSettleCount)
      : 0
  }

  get visualSettleMaxOutCount(): number {
    return this.visualSettleMaxOuts
  }

  get cookieCleanupActionCount(): number {
    return this.cookieCleanupActions
  }

  get averageScreenshotMs(): number {
    return this.renderCount > 0 ? Math.round(this.screenshotTotalMs / this.renderCount) : 0
  }

  get screenshotOptimizationStatus(): string {
    if (this.screenshotOptimizeForSpeed === true) return 'optimizeForSpeed enabled'
    if (this.screenshotOptimizeForSpeed === false) return 'optimizeForSpeed unsupported'

    return 'optimizeForSpeed probing'
  }

  get lastFailureSummary(): string {
    return this.lastRenderFailure
  }

  resetMetrics() {
    this.browserLaunches = 0
    this.browserCloses = 0
    this.browserLaunchFailures = 0
    this.browserLaunchTotalMs = 0
    this.renderFailures = 0
    this.renderTotalMs = 0
    this.renderCount = 0
    this.setupTotalMs = 0
    this.setupCount = 0
    this.navigationTotalMs = 0
    this.navigationReadinessProbeWins = 0
    this.paintReadyTotalMs = 0
    this.paintReadyCount = 0
    this.visualSettleTotalMs = 0
    this.visualSettleCount = 0
    this.visualSettleMaxOuts = 0
    this.cookieCleanupActions = 0
    this.screenshotTotalMs = 0
    this.lastRenderFailure = 'none'
  }

  render(url: string, width: number, height: number, captureScale = 1): LocalBrowserRenderTask {
    const startedAt = performance.now()
    let cancelled = false
    let targetId: string | null = null
    let runtime: BrowserRuntime | null = null
    let stage = 'browser startup'

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

        stage = 'target setup'
        const setupStartedAt = performance.now()
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
        const safeCaptureScale = Math.max(0.1, Math.min(1, captureScale))

        await Promise.all([
          runtime.connection.send('Page.enable', {}, sessionId),
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
              features: [
                { name: 'prefers-color-scheme', value: 'light' },
                { name: 'prefers-reduced-motion', value: 'reduce' }
              ]
            },
            sessionId
          )
        ])

        this.setupTotalMs += performance.now() - setupStartedAt
        this.setupCount++

        stage = 'navigation'
        const domReady = runtime.connection
          .waitForEvent('Page.domContentEventFired', sessionId, NAVIGATION_TIMEOUT_MS)
          .then(() => 'event' as const)
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

        const readinessSource = await this.waitForNavigationReadiness(
          domReady,
          runtime.connection,
          sessionId
        )

        if (readinessSource === 'probe') {
          this.navigationReadinessProbeWins++
        }

        if (cancelled) {
          throw new Error('Local browser render cancelled')
        }

        const navigationMs = performance.now() - navigationStartedAt
        stage = 'paint/theme'
        const paintStartedAt = performance.now()
        const preparation = runtime.connection
          .send<{
            result?: {
              value?: unknown
            }
          }>(
            'Runtime.evaluate',
            {
              expression: `(() => {
                ${LIGHT_THEME_SCRIPT};
                return ${COOKIE_CLEANUP_SCRIPT}
              })()`,
              returnByValue: true
            },
            sessionId,
            PAINT_READY_TIMEOUT_MS + 100
          )
          .catch(() => ({ result: { value: 0 } }))

        await Promise.race([preparation.then(() => undefined), delay(PAINT_READY_TIMEOUT_MS)])

        const paintReadyMs = performance.now() - paintStartedAt
        this.paintReadyTotalMs += paintReadyMs
        this.paintReadyCount++

        const preparationResponse = await preparation
        const cleanupActions =
          typeof preparationResponse.result?.value === 'number'
            ? preparationResponse.result.value
            : 0

        this.cookieCleanupActions += cleanupActions

        if (cancelled) {
          throw new Error('Local browser render cancelled')
        }

        stage = 'visual settle'
        const visualSettleStartedAt = performance.now()
        const settleResponse = await runtime.connection
          .send<{
            result?: {
              value?: unknown
            }
          }>(
            'Runtime.evaluate',
            {
              expression: VISUAL_SETTLE_SCRIPT,
              awaitPromise: true,
              returnByValue: true
            },
            sessionId,
            VISUAL_SETTLE_COMMAND_TIMEOUT_MS
          )
          .catch(() => ({ result: { value: null } }))
        const visualSettleMs = performance.now() - visualSettleStartedAt
        const settleValue = settleResponse.result?.value
        const settleRecord =
          settleValue && typeof settleValue === 'object'
            ? (settleValue as { maxedOut?: unknown; title?: unknown })
            : null

        this.visualSettleTotalMs += visualSettleMs
        this.visualSettleCount++

        if (settleRecord?.maxedOut === true) {
          this.visualSettleMaxOuts++
        }

        const lateCleanupResponse = await runtime.connection
          .send<{
            result?: {
              value?: unknown
            }
          }>(
            'Runtime.evaluate',
            {
              expression: COOKIE_CLEANUP_SCRIPT,
              returnByValue: true
            },
            sessionId,
            PAINT_READY_TIMEOUT_MS + 100
          )
          .catch(() => ({ result: { value: 0 } }))
        const lateCleanupActions =
          typeof lateCleanupResponse.result?.value === 'number'
            ? lateCleanupResponse.result.value
            : 0

        this.cookieCleanupActions += lateCleanupActions

        if (lateCleanupActions > 0) {
          await delay(180)
        }

        if (cancelled) {
          throw new Error('Local browser render cancelled')
        }

        stage = 'screenshot'
        const screenshotStartedAt = performance.now()
        const screenshot = await this.captureScreenshot(
          runtime.connection,
          sessionId,
          safeWidth,
          safeHeight,
          safeCaptureScale
        )
        const screenshotMs = performance.now() - screenshotStartedAt
        const settledTitle = typeof settleRecord?.title === 'string' ? settleRecord.title : ''

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
          title: settledTitle,
          totalMs,
          navigationMs,
          paintReadyMs,
          screenshotMs
        }
      } catch (error) {
        if (!cancelled) {
          this.renderFailures++
          this.lastRenderFailure = `${stage}: ${url} — ${toError(error).message}`
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

  private waitForNavigationReadiness(
    domReady: Promise<'event'>,
    connection: CdpConnection,
    sessionId: string
  ): Promise<'event' | 'probe'> {
    const probe = this.waitForDocumentReady(connection, sessionId).then(() => 'probe' as const)

    return new Promise((resolve, reject) => {
      let failures = 0
      let lastError: Error | null = null
      let settled = false

      const succeed = (source: 'event' | 'probe') => {
        if (settled) return

        settled = true
        resolve(source)
      }

      const fail = (error: unknown) => {
        if (settled) return

        failures++
        lastError = toError(error)

        if (failures < 2) return

        settled = true
        reject(lastError)
      }

      void domReady.then(succeed).catch(fail)
      void probe.then(succeed).catch(fail)
    })
  }

  private async waitForDocumentReady(connection: CdpConnection, sessionId: string): Promise<void> {
    const deadline = performance.now() + NAVIGATION_TIMEOUT_MS
    let lastError: Error | null = null

    while (performance.now() < deadline) {
      const remainingMs = Math.max(1, deadline - performance.now())

      try {
        const response = await connection.send<{
          result?: {
            value?: unknown
          }
        }>(
          'Runtime.evaluate',
          {
            expression: `(() => ({
              ready:
                document.readyState === 'interactive' ||
                document.readyState === 'complete',
              href: location.href,
              hasDocumentElement: Boolean(document.documentElement)
            }))()`,
            returnByValue: true
          },
          sessionId,
          Math.min(DOCUMENT_READY_PROBE_COMMAND_TIMEOUT_MS, remainingMs)
        )
        const value = response.result?.value

        if (
          value &&
          typeof value === 'object' &&
          'ready' in value &&
          value.ready === true &&
          'href' in value &&
          typeof value.href === 'string' &&
          value.href !== 'about:blank' &&
          'hasDocumentElement' in value &&
          value.hasDocumentElement === true
        ) {
          return
        }
      } catch (error) {
        lastError = toError(error)
      }

      await delay(Math.min(DOCUMENT_READY_PROBE_INTERVAL_MS, remainingMs))
    }

    throw new Error(
      lastError
        ? `Document readiness probe timed out: ${lastError.message}`
        : 'Document readiness probe timed out'
    )
  }

  private async captureScreenshot(
    connection: CdpConnection,
    sessionId: string,
    viewportWidth: number,
    viewportHeight: number,
    captureScale: number
  ): Promise<{ data: string }> {
    const baseOptions = {
      format: 'jpeg',
      quality: 76,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: 0,
        y: 0,
        width: viewportWidth,
        height: viewportHeight,
        scale: captureScale
      }
    }

    if (this.screenshotOptimizeForSpeed !== false) {
      try {
        const screenshot = await connection.send<{ data: string }>(
          'Page.captureScreenshot',
          {
            ...baseOptions,
            optimizeForSpeed: true
          },
          sessionId,
          CDP_COMMAND_TIMEOUT_MS
        )

        this.screenshotOptimizeForSpeed = true
        return screenshot
      } catch (error) {
        if (
          this.screenshotOptimizeForSpeed !== null ||
          !isUnsupportedScreenshotSpeedOption(error)
        ) {
          throw error
        }

        this.screenshotOptimizeForSpeed = false
      }
    }

    return connection.send<{ data: string }>(
      'Page.captureScreenshot',
      baseOptions,
      sessionId,
      CDP_COMMAND_TIMEOUT_MS
    )
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
