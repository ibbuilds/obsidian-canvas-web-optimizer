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
const VISUAL_SETTLE_MIN_MS = 260
const VISUAL_SETTLE_COMPLEX_MIN_MS = 520
const VISUAL_SETTLE_QUIET_MS = 120
const VISUAL_SETTLE_MAX_MS = 850
const VISUAL_SETTLE_COMPLEX_MAX_MS = 1800
const VISUAL_SETTLE_COMMAND_TIMEOUT_MS = 2400
const CAPTURE_HEALTH_COMMAND_TIMEOUT_MS = 900
const CAPTURE_INTRO_MAX_FROM_NAVIGATION_MS = 5500
const CAPTURE_INTRO_POLL_MS = 250
const CAPTURE_RECOVERY_WAIT_MS = 280
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

type CaptureHealthRecord = {
  suspicious?: boolean
  reasons?: unknown
  score?: unknown
}

const NATURAL_INTRO_REASONS = new Set([
  'progress-visible',
  'loading-copy',
  'loading-percent',
  'loading-text',
  'hero-hidden',
  'hero-blurred',
  'hero-clipped',
  'hero-transform',
  'fullscreen-cover',
  'content-mostly-hidden'
])

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

const COOKIE_GUARD_BOOTSTRAP_SCRIPT = String.raw`
  (() => {
    if (globalThis.__canvasWebOptimizerCookieGuard) return

    const state = {
      actions: 0,
      clicks: 0,
      hides: 0,
      scans: 0
    }

    Object.defineProperty(globalThis, '__canvasWebOptimizerCookieGuard', {
      value: state,
      configurable: true
    })

    try {
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
        configurable: true,
        get: () => true
      })
    } catch {}

    try {
      Object.defineProperty(Navigator.prototype, 'doNotTrack', {
        configurable: true,
        get: () => '1'
      })
    } catch {}

    const styleId = 'canvas-web-optimizer-cookie-guard'
    const knownSelectors = [
      '#onetrust-banner-sdk',
      '#onetrust-consent-sdk',
      '#CybotCookiebotDialog',
      '#CybotCookiebotDialogBodyUnderlay',
      '#didomi-host',
      '.qc-cmp2-container',
      '.qc-cmp-cleanslate',
      '.truste_popframe',
      '#usercentrics-root',
      '.iubenda-cs-container',
      '[id*="cookie-banner" i]',
      '[class*="cookie-banner" i]',
      '[id*="cookie-consent" i]',
      '[class*="cookie-consent" i]',
      '[id*="consent-banner" i]',
      '[class*="consent-banner" i]',
      '[data-testid*="cookie-banner" i]',
      '[data-testid*="cookie-consent" i]'
    ]
    const candidateSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[id*="cookie" i]',
      '[class*="cookie" i]',
      '[id*="consent" i]',
      '[class*="consent" i]',
      '[id*="gdpr" i]',
      '[class*="gdpr" i]',
      '[id*="cmp" i]',
      '[class*="cmp" i]',
      '[data-testid*="cookie" i]',
      '[data-testid*="consent" i]'
    ]
    const consentText =
      /cookie|consent|privacy preferences|tracking|gdpr|personal data|data partners/i
    const rejectText =
      /reject|decline|deny|essential only|necessary only|continue without|do not accept|no thanks|only necessary/i
    let observer = null
    let scheduled = false
    let interval = 0

    const ensureStyle = () => {
      if (document.getElementById(styleId)) return

      const style = document.createElement('style')
      style.id = styleId
      style.textContent =
        knownSelectors.join(',') +
        '{display:none!important;visibility:hidden!important;opacity:0!important;' +
        'pointer-events:none!important;}'

      ;(document.head || document.documentElement)?.appendChild(style)
    }

    const isVisible = element => {
      if (!(element instanceof HTMLElement)) return false

      const rect = element.getBoundingClientRect()

      if (rect.width <= 0 || rect.height <= 0) return false

      const style = getComputedStyle(element)

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.02
      )
    }

    const restoreScrolling = () => {
      for (const element of [document.documentElement, document.body]) {
        if (!(element instanceof HTMLElement)) continue

        element.style.setProperty('overflow', 'auto', 'important')
        element.style.removeProperty('position')
        element.style.removeProperty('inset')
        element.style.removeProperty('height')
      }
    }

    const hide = element => {
      if (!(element instanceof HTMLElement)) return false

      element.style.setProperty('display', 'none', 'important')
      element.style.setProperty('visibility', 'hidden', 'important')
      element.style.setProperty('opacity', '0', 'important')
      element.style.setProperty('pointer-events', 'none', 'important')
      state.actions++
      state.hides++
      return true
    }

    const findRejectControl = root => {
      const controls = root.querySelectorAll(
        'button, [role="button"], input[type="button"], input[type="submit"], a'
      )

      for (const control of controls) {
        if (!(control instanceof HTMLElement) || !isVisible(control)) continue

        const label = [
          control.getAttribute('aria-label') || '',
          control.getAttribute('title') || '',
          control instanceof HTMLInputElement ? control.value : '',
          control.textContent || ''
        ]
          .join(' ')
          .replace(/ +/g, ' ')
          .trim()

        if (rejectText.test(label)) {
          return control
        }
      }

      return null
    }

    const looksLikeConsent = element => {
      if (!(element instanceof HTMLElement)) return false

      const text = (element.innerText || element.textContent || '').trim()
      const semanticName = [
        element.id,
        typeof element.className === 'string' ? element.className : '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('data-testid') || ''
      ].join(' ')

      return consentText.test(text) || /cookie|consent|gdpr|cmp/i.test(semanticName)
    }

    const candidateRoots = () => {
      const roots = new Set()

      for (const selector of candidateSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          roots.add(element)
        }
      }

      const points = [
        [innerWidth * 0.15, innerHeight - 12],
        [innerWidth * 0.35, innerHeight - 12],
        [innerWidth * 0.5, innerHeight - 12],
        [innerWidth * 0.65, innerHeight - 12],
        [innerWidth * 0.85, innerHeight - 12],
        [innerWidth * 0.2, innerHeight * 0.72],
        [innerWidth * 0.8, innerHeight * 0.72],
        [innerWidth / 2, innerHeight / 2]
      ]

      for (const [x, y] of points) {
        for (const hit of document.elementsFromPoint(x, y)) {
          let current = hit

          for (let depth = 0; depth < 5 && current instanceof HTMLElement; depth++) {
            roots.add(current)
            current = current.parentElement
          }
        }
      }

      return roots
    }

    const hideBackdropAfterConsent = () => {
      const center = document.elementFromPoint(innerWidth / 2, innerHeight / 2)

      if (!(center instanceof HTMLElement)) return

      let current = center

      for (let depth = 0; depth < 5 && current; depth++) {
        const style = getComputedStyle(current)
        const rect = current.getBoundingClientRect()
        const viewportArea = Math.max(innerWidth * innerHeight, 1)
        const areaRatio = (rect.width * rect.height) / viewportArea
        const name = (current.id + ' ' + current.className).toLowerCase()

        if (
          areaRatio >= 0.72 &&
          (style.position === 'fixed' || style.position === 'absolute') &&
          /backdrop|overlay|modal|consent|cookie|cmp/.test(name)
        ) {
          hide(current)
          return
        }

        current = current.parentElement
      }
    }

    const clean = () => {
      scheduled = false
      state.scans++
      ensureStyle()

      let changed = false

      for (const root of candidateRoots()) {
        if (!(root instanceof HTMLElement) || !isVisible(root)) continue
        if (!looksLikeConsent(root)) continue

        const style = getComputedStyle(root)
        const rect = root.getBoundingClientRect()
        const viewportArea = Math.max(innerWidth * innerHeight, 1)
        const areaRatio = (rect.width * rect.height) / viewportArea
        const roleDialog =
          root.getAttribute('role') === 'dialog' || root.getAttribute('aria-modal') === 'true'

        if (
          !roleDialog &&
          style.position !== 'fixed' &&
          style.position !== 'sticky' &&
          areaRatio < 0.025
        ) {
          continue
        }

        const reject = findRejectControl(root)

        if (reject) {
          try {
            reject.click()
            state.actions++
            state.clicks++
            changed = true
          } catch {
            changed = hide(root) || changed
          }
        } else {
          changed = hide(root) || changed
        }
      }

      if (changed) {
        restoreScrolling()
        hideBackdropAfterConsent()
      }
    }

    const scheduleClean = () => {
      if (scheduled) return

      scheduled = true
      queueMicrotask(clean)
    }

    const installObserver = () => {
      if (observer || !document.documentElement) return

      observer = new MutationObserver(scheduleClean)
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true
      })
    }

    const start = () => {
      ensureStyle()
      installObserver()
      clean()

      if (!interval) {
        interval = setInterval(clean, 220)

        setTimeout(() => {
          clearInterval(interval)
          interval = 0
        }, 12000)
      }
    }

    if (document.documentElement) {
      start()
    } else {
      const bootstrapObserver = new MutationObserver(() => {
        if (!document.documentElement) return

        bootstrapObserver.disconnect()
        start()
      })

      bootstrapObserver.observe(document, {
        subtree: true,
        childList: true
      })
    }

    addEventListener('DOMContentLoaded', start, { once: true })
    addEventListener('load', clean, { once: true })
  })()
`

const COOKIE_GUARD_STATUS_SCRIPT =
  'globalThis.__canvasWebOptimizerCookieGuard?.actions ?? 0'

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
    const semanticContainers = [
      '[role="dialog"][id*="cookie" i]',
      '[role="dialog"][class*="cookie" i]',
      '[role="dialog"][id*="consent" i]',
      '[role="dialog"][class*="consent" i]',
      '[aria-label*="cookie" i]',
      '[aria-label*="consent" i]',
      '[data-testid*="cookie" i]',
      '[data-testid*="consent" i]',
      '[id*="cookie" i][class]',
      '[class*="cookie" i]',
      '[id*="consent" i][class]',
      '[class*="consent" i]'
    ]
    const rejectText =
      /reject|decline|deny|essential only|necessary only|continue without|do not accept|no thanks/i
    let actions = 0

    for (const selector of rejectSelectors) {
      const element = document.querySelector(selector)

      if (element instanceof HTMLElement && element.getClientRects().length > 0) {
        element.click()
        actions++
        break
      }
    }

    const hideContainer = element => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false

      element.style.setProperty('display', 'none', 'important')
      element.style.setProperty('visibility', 'hidden', 'important')
      element.style.setProperty('pointer-events', 'none', 'important')
      actions++
      return true
    }

    if (actions === 0) {
      for (const selector of knownContainers) {
        for (const element of document.querySelectorAll(selector)) {
          hideContainer(element)
        }
      }
    }

    if (actions === 0) {
      const containers = new Set()

      for (const selector of semanticContainers) {
        for (const element of document.querySelectorAll(selector)) {
          containers.add(element)
        }
      }

      for (const element of containers) {
        if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) continue

        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const viewportArea = Math.max(innerWidth * innerHeight, 1)
        const areaRatio = Math.max(rect.width * rect.height, 0) / viewportArea
        const text = element.textContent?.trim() ?? ''
        const looksLikeConsent =
          /cookie|consent|privacy|tracking|gdpr/i.test(text) ||
          /cookie|consent/i.test(element.id + ' ' + element.className)

        if (!looksLikeConsent) continue
        if (
          style.position !== 'fixed' &&
          style.position !== 'sticky' &&
          areaRatio < 0.08
        ) {
          continue
        }

        const controls = element.querySelectorAll('button, [role="button"], a')

        for (const control of controls) {
          const label = control.textContent?.trim() ?? ''

          if (
            rejectText.test(label) &&
            control instanceof HTMLElement &&
            control.getClientRects().length > 0
          ) {
            control.click()
            actions++
            break
          }
        }

        if (actions === 0) {
          hideContainer(element)
        }

        if (actions > 0) break
      }
    }

    if (actions > 0) {
      document.documentElement.style.removeProperty('overflow')
      document.body?.style.removeProperty('overflow')
      document.documentElement.style.removeProperty('position')
      document.body?.style.removeProperty('position')
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

    const intersectsViewport = rect =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth

    const isVisibleElement = element => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false

      const rect = element.getBoundingClientRect()

      if (!intersectsViewport(rect)) return false

      const style = getComputedStyle(element)

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05
      )
    }

    const visibleImagesReady = () => {
      for (const image of document.images) {
        if (!isVisibleElement(image)) continue

        if (!image.complete || image.naturalWidth <= 0) {
          return false
        }
      }

      return true
    }

    const visibleVideosReady = () => {
      for (const video of document.querySelectorAll('video')) {
        if (!isVisibleElement(video)) continue

        if (video.readyState < 2) {
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

    const getLoaderOverlays = () => {
      const selectors = [
        '[id*="preloader" i]',
        '[class*="preloader" i]',
        '[id*="page-loader" i]',
        '[class*="page-loader" i]',
        '[id="loader"]',
        '[class~="loader"]',
        '[id*="splash" i]',
        '[class*="splash" i]',
        '[id*="curtain" i]',
        '[class*="curtain" i]',
        '[id*="transition" i]',
        '[class*="transition" i]',
        '[aria-busy="true"]'
      ]
      const results = new Set()

      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (!(element instanceof HTMLElement) || !isVisibleElement(element)) continue

          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          const viewportArea = Math.max(innerWidth * innerHeight, 1)
          const areaRatio = (rect.width * rect.height) / viewportArea
          const text = element.textContent?.trim() ?? ''
          const name = (element.id + ' ' + element.className).toLowerCase()
          const looksLikeLoader =
            /loader|preloader|loading|splash|curtain|page-transition/.test(name) ||
            /loading|please wait|enter site/i.test(text)

          if (!looksLikeLoader) continue

          if (
            areaRatio >= 0.32 ||
            style.position === 'fixed' ||
            style.position === 'sticky'
          ) {
            results.add(element)
          }
        }
      }

      return [...results]
    }

    const primaryHeadingHidden = () => {
      const heading = document.querySelector('h1')

      if (!(heading instanceof HTMLElement)) return false

      const style = getComputedStyle(heading)

      if (heading.offsetTop > innerHeight * 1.5) return false

      return (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity || '1') <= 0.08
      )
    }

    const dynamicSurfaceVisible = () => {
      for (const element of document.querySelectorAll('canvas, video')) {
        if (isVisibleElement(element)) return true
      }

      return false
    }

    const finishAnimations = () => {
      if (typeof document.getAnimations !== 'function') return

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

    const hideStuckLoaders = () => {
      let hidden = 0

      for (const element of getLoaderOverlays()) {
        element.style.setProperty('display', 'none', 'important')
        element.style.setProperty('visibility', 'hidden', 'important')
        element.style.setProperty('pointer-events', 'none', 'important')
        hidden++
      }

      return hidden
    }

    const finish = (maxedOut, complex) => {
      if (finished) return

      finished = true
      observer.disconnect()
      removeEventListener('load', markActivity, true)

      finishAnimations()
      const loaderBypasses = maxedOut ? hideStuckLoaders() : 0

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

      setTimeout(() => {
        resolve({
          waitedMs: performance.now() - startedAt,
          maxedOut,
          complex,
          loaderBypasses,
          title: document.title || location.hostname || location.href
        })
      }, 50)
    }

    const tick = () => {
      const now = performance.now()
      const elapsed = now - startedAt
      const quietFor = now - lastActivityAt
      const loaderVisible = getLoaderOverlays().length > 0
      const hiddenHeading = primaryHeadingHidden()
      const dynamicSurface = dynamicSurfaceVisible()
      const complex = loaderVisible || hiddenHeading || dynamicSurface
      const minimumWait = complex
        ? ${VISUAL_SETTLE_COMPLEX_MIN_MS}
        : ${VISUAL_SETTLE_MIN_MS}
      const maximumWait = complex
        ? ${VISUAL_SETTLE_COMPLEX_MAX_MS}
        : ${VISUAL_SETTLE_MAX_MS}
      const fontsReady = !document.fonts || document.fonts.status !== 'loading'
      const ready =
        elapsed >= minimumWait &&
        quietFor >= ${VISUAL_SETTLE_QUIET_MS} &&
        fontsReady &&
        visibleImagesReady() &&
        visibleVideosReady() &&
        !loaderVisible &&
        !hiddenHeading

      if (ready) {
        finish(false, complex)
        return
      }

      if (elapsed >= maximumWait) {
        finish(true, complex)
        return
      }

      setTimeout(tick, 50)
    }

    setTimeout(tick, 50)
  })
`

const CAPTURE_HEALTH_SCRIPT = String.raw`
  (() => {
    const reasons = []
    let score = 0
    const viewportArea = Math.max(innerWidth * innerHeight, 1)

    const isVisible = element => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false

      const rect = element.getBoundingClientRect()

      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= innerHeight ||
        rect.left >= innerWidth
      ) {
        return false
      }

      const style = getComputedStyle(element)

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.04
      )
    }

    const add = (reason, weight) => {
      if (!reasons.includes(reason)) {
        reasons.push(reason)
      }

      score += weight
    }

    const progressNodes = document.querySelectorAll(
      'progress, [role="progressbar"], [aria-busy="true"]'
    )

    for (const element of progressNodes) {
      if (isVisible(element)) {
        add('progress-visible', 4)
        break
      }
    }

    const bodyText = (document.body?.innerText ?? '').replaceAll('\n', ' ').trim()
    const compactBodyText = bodyText.replace(/ +/g, ' ')

    if (
      compactBodyText.length <= 320 &&
      /(?:^| )(?:loading|please wait|initializing|preparing|entering)(?: |:|[.]|[0-9]|%|$)/i.test(
        compactBodyText
      )
    ) {
      add('loading-copy', 4)
    }

    if (/\b[0-9]{1,3}%\b/.test(compactBodyText) && compactBodyText.length <= 420) {
      add('loading-percent', 4)
    }

    const elements = document.body?.getElementsByTagName('*')
    const elementCount = elements?.length ?? 0
    let visibleTextLength = 0

    for (let index = 0; index < Math.min(elementCount, 900); index++) {
      const element = elements?.item(index)

      if (!(element instanceof HTMLElement) || !isVisible(element)) continue

      const ownText = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent?.trim() ?? '')
        .join(' ')
        .trim()

      if (ownText) {
        visibleTextLength += ownText.length
      }

      if (ownText.length > 0 && ownText.length <= 120) {
        const normalized = ownText.replaceAll('\n', ' ').replaceAll('\t', ' ').replace(/ +/g, ' ').trim()

        if (
          /^(loading|loading\s*\d{1,3}%|please wait|initializing|preparing|entering|\d{1,3}%$)/i.test(
            normalized
          )
        ) {
          add('loading-text', 4)
          break
        }
      }
    }

    const heading = document.querySelector('h1, [role="heading"][aria-level="1"]')

    if (heading instanceof HTMLElement && heading.offsetTop < innerHeight * 1.5) {
      const heroNodes = [heading, ...heading.querySelectorAll('*')]
      let parent = heading.parentElement

      for (let depth = 0; depth < 3 && parent; depth++) {
        heroNodes.push(parent)
        parent = parent.parentElement
      }

      for (const node of heroNodes) {
        if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue

        const style = getComputedStyle(node)
        const opacity = Number.parseFloat(style.opacity || '1')
        const filter = style.filter || ''
        const clipPath = style.clipPath || ''
        const rect = node.getBoundingClientRect()

        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          opacity <= 0.08
        ) {
          add('hero-hidden', 4)
        }

        const blurMatch = filter.match(/blur\(([-0-9.]+)px\)/i)
        const blur = blurMatch ? Number.parseFloat(blurMatch[1]) : 0

        if (Number.isFinite(blur) && blur >= 1.5) {
          add('hero-blurred', 3)
        }

        if (clipPath && clipPath !== 'none' && clipPath !== 'inset(0px)') {
          add('hero-clipped', 2)
        }

        if (style.transform && style.transform !== 'none') {
          try {
            const matrix = new DOMMatrixReadOnly(style.transform)
            const scaleX = Math.hypot(matrix.a, matrix.b)
            const scaleY = Math.hypot(matrix.c, matrix.d)
            const translatedFar =
              Math.abs(matrix.e) > Math.max(rect.width, 1) * 0.45 ||
              Math.abs(matrix.f) > Math.max(rect.height, 1) * 0.9

            if (scaleX < 0.72 || scaleY < 0.72 || translatedFar) {
              add('hero-transform', 2)
            }
          } catch {}
        }

        if (score >= 4) break
      }
    }

    const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]')

    for (const element of dialogs) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue

      const rect = element.getBoundingClientRect()
      const areaRatio = (rect.width * rect.height) / viewportArea

      if (areaRatio >= 0.18) {
        add('large-dialog', 2)
        break
      }
    }

    const fixedCandidates = document.querySelectorAll('body *')

    for (let index = 0; index < Math.min(fixedCandidates.length, 450); index++) {
      const element = fixedCandidates[index]

      if (!(element instanceof HTMLElement) || !isVisible(element)) continue

      const style = getComputedStyle(element)

      if (style.position !== 'fixed' && style.position !== 'sticky') continue

      const rect = element.getBoundingClientRect()
      const areaRatio = (rect.width * rect.height) / viewportArea

      if (areaRatio < 0.4) continue

      const text = element.textContent?.trim() ?? ''
      const hasControls = Boolean(element.querySelector('button, [role="button"], input, form'))
      const looksTransient =
        /loading|please wait|cookie|consent|privacy|subscribe|sign up|join|member/i.test(text)

      if (hasControls || looksTransient) {
        add('large-overlay', 2)
        break
      }
    }

    const centerElement = document.elementFromPoint(innerWidth / 2, innerHeight / 2)

    if (centerElement instanceof HTMLElement) {
      const style = getComputedStyle(centerElement)
      const rect = centerElement.getBoundingClientRect()
      const areaRatio = Math.max(rect.width * rect.height, 0) / viewportArea
      const hasMainBehind = Boolean(
        document.querySelector('main, [role="main"], #main, [data-main]')
      )

      if (
        hasMainBehind &&
        areaRatio >= 0.72 &&
        (style.position === 'fixed' || style.position === 'absolute') &&
        centerElement.tagName !== 'MAIN'
      ) {
        add('fullscreen-cover', 2)
      }
    }

    const bodyTextLength = (document.body?.innerText ?? '').trim().length

    if (bodyTextLength > 500 && visibleTextLength < 24) {
      add('content-mostly-hidden', 2)
    }

    return {
      suspicious: score >= 2,
      score,
      reasons,
      visibleTextLength,
      bodyTextLength
    }
  })()
`

const CAPTURE_RECOVERY_SCRIPT = String.raw`
  (() => {
    let actions = 0
    const viewportArea = Math.max(innerWidth * innerHeight, 1)

    const isVisible = element => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false

      const rect = element.getBoundingClientRect()

      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= innerHeight ||
        rect.left >= innerWidth
      ) {
        return false
      }

      const style = getComputedStyle(element)

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.04
      )
    }

    const hide = element => {
      if (!(element instanceof HTMLElement)) return

      element.style.setProperty('display', 'none', 'important')
      element.style.setProperty('visibility', 'hidden', 'important')
      element.style.setProperty('pointer-events', 'none', 'important')
      actions++
    }

    const loaderSelectors = [
      '[id*="loader" i]',
      '[class*="loader" i]',
      '[id*="preloader" i]',
      '[class*="preloader" i]',
      '[id*="splash" i]',
      '[class*="splash" i]',
      '[id*="curtain" i]',
      '[class*="curtain" i]',
      '[id*="transition" i]',
      '[class*="transition" i]',
      'progress',
      '[role="progressbar"]',
      '[aria-busy="true"]'
    ]

    for (const selector of loaderSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement) || !isVisible(element)) continue

        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const areaRatio = (rect.width * rect.height) / viewportArea
        const text = element.textContent?.trim() ?? ''
        const name = (element.id + ' ' + element.className).toLowerCase()
        const looksLikeLoader =
          /loader|preloader|loading|splash|curtain|transition/.test(name) ||
          /loading|please wait|initializing|preparing|[0-9]{1,3}%/i.test(text)

        if (
          looksLikeLoader &&
          (areaRatio >= 0.08 || style.position === 'fixed' || style.position === 'sticky')
        ) {
          hide(element)
        }
      }
    }

    const heading = document.querySelector('h1, [role="heading"][aria-level="1"]')

    if (heading instanceof HTMLElement && heading.offsetTop < innerHeight * 1.5) {
      const candidates = [heading, ...heading.querySelectorAll('*')]
      let parent = heading.parentElement

      for (let depth = 0; depth < 3 && parent; depth++) {
        candidates.push(parent)
        parent = parent.parentElement
      }

      for (const element of candidates) {
        if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue

        const style = getComputedStyle(element)
        const opacity = Number.parseFloat(style.opacity || '1')
        const blurMatch = (style.filter || '').match(/blur\(([-\d.]+)px\)/i)
        const blur = blurMatch ? Number.parseFloat(blurMatch[1]) : 0
        const rect = element.getBoundingClientRect()
        let transformLooksTransient = false

        if (style.transform && style.transform !== 'none') {
          try {
            const matrix = new DOMMatrixReadOnly(style.transform)
            const scaleX = Math.hypot(matrix.a, matrix.b)
            const scaleY = Math.hypot(matrix.c, matrix.d)

            transformLooksTransient =
              scaleX < 0.72 ||
              scaleY < 0.72 ||
              Math.abs(matrix.e) > Math.max(rect.width, 1) * 0.45 ||
              Math.abs(matrix.f) > Math.max(rect.height, 1) * 0.9
          } catch {}
        }

        const clipLooksTransient =
          Boolean(style.clipPath) &&
          style.clipPath !== 'none' &&
          style.clipPath !== 'inset(0px)'
        const maskLooksTransient =
          Boolean(style.maskImage) && style.maskImage !== 'none'

        if (
          style.visibility === 'hidden' ||
          opacity <= 0.2 ||
          (Number.isFinite(blur) && blur >= 1.5) ||
          clipLooksTransient ||
          maskLooksTransient ||
          transformLooksTransient
        ) {
          element.style.setProperty('visibility', 'visible', 'important')
          element.style.setProperty('opacity', '1', 'important')
          element.style.setProperty('filter', 'none', 'important')
          element.style.setProperty('transform', 'none', 'important')
          element.style.setProperty('clip-path', 'none', 'important')
          element.style.setProperty('mask-image', 'none', 'important')
          actions++
        }
      }
    }

    const visibleElements = document.body?.querySelectorAll('*') ?? []

    for (let index = 0; index < Math.min(visibleElements.length, 900); index++) {
      const element = visibleElements[index]

      if (!(element instanceof HTMLElement) || !isVisible(element)) continue

      const ownText = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent?.trim() ?? '')
        .join(' ')
        .replace(/ +/g, ' ')
        .trim()

      if (
        ownText.length === 0 ||
        ownText.length > 120 ||
        !/^(?:loading|please wait|initializing|preparing|entering|[0-9]{1,3}%)(?:\s|:|\.|[0-9]|%|$)/i.test(
          ownText
        )
      ) {
        continue
      }

      let candidate = element
      let parent = element.parentElement

      for (let depth = 0; depth < 5 && parent; depth++) {
        const style = getComputedStyle(parent)
        const rect = parent.getBoundingClientRect()
        const areaRatio = Math.max(rect.width * rect.height, 0) / viewportArea

        if (
          areaRatio >= 0.08 &&
          (style.position === 'fixed' ||
            style.position === 'absolute' ||
            style.position === 'sticky')
        ) {
          candidate = parent
        }

        parent = parent.parentElement
      }

      hide(candidate)
      break
    }

    const main = document.querySelector('main, [role="main"], #main, [data-main]')
    let centerCover = document.elementFromPoint(innerWidth / 2, innerHeight / 2)

    for (let depth = 0; depth < 6 && centerCover instanceof HTMLElement; depth++) {
      const style = getComputedStyle(centerCover)
      const rect = centerCover.getBoundingClientRect()
      const areaRatio = Math.max(rect.width * rect.height, 0) / viewportArea

      if (
        main instanceof HTMLElement &&
        !centerCover.contains(main) &&
        areaRatio >= 0.72 &&
        (style.position === 'fixed' || style.position === 'absolute') &&
        centerCover !== document.body &&
        centerCover !== document.documentElement
      ) {
        hide(centerCover)
        break
      }

      centerCover = centerCover.parentElement
    }

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

          actions++
        } catch {}
      }
    }

    for (const video of document.querySelectorAll('video')) {
      if (!isVisible(video)) continue

      try {
        video.muted = true
        void video.play().catch(() => {})
      } catch {}
    }

    const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]')

    for (const element of dialogs) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue

      const rect = element.getBoundingClientRect()
      const areaRatio = (rect.width * rect.height) / viewportArea

      if (areaRatio < 0.18) continue

      const buttons = element.querySelectorAll('button, [role="button"], a')
      let dismissed = false

      for (const button of buttons) {
        const label =
          (button.getAttribute('aria-label') ?? '') + ' ' + (button.textContent?.trim() ?? '')

        if (/close|dismiss|no thanks|skip|not now|decline|reject/i.test(label)) {
          if (button instanceof HTMLElement && isVisible(button)) {
            button.click()
            actions++
            dismissed = true
            break
          }
        }
      }

      if (!dismissed) {
        const text = element.textContent?.trim() ?? ''

        if (/cookie|consent|privacy|subscribe|sign up|join|member/i.test(text)) {
          hide(element)
        }
      }
    }

    scrollTo(0, 0)
    dispatchEvent(new Event('resize'))
    dispatchEvent(new Event('scroll'))

    return actions
  })()
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
  private visualSettleComplexCount = 0
  private visualSettleCommandFailures = 0
  private loaderBypasses = 0
  private cookieCleanupActions = 0
  private cookieGuardActions = 0
  private captureRecoveries = 0
  private unresolvedSuspiciousCaptures = 0
  private introWaits = 0
  private introNaturalResolutions = 0
  private introWaitTotalMs = 0
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

  get visualSettleComplexPageCount(): number {
    return this.visualSettleComplexCount
  }

  get visualSettleCommandFailureCount(): number {
    return this.visualSettleCommandFailures
  }

  get loaderBypassCount(): number {
    return this.loaderBypasses
  }

  get cookieCleanupActionCount(): number {
    return this.cookieCleanupActions
  }

  get cookieGuardActionCount(): number {
    return this.cookieGuardActions
  }

  get captureRecoveryCount(): number {
    return this.captureRecoveries
  }

  get unresolvedSuspiciousCaptureCount(): number {
    return this.unresolvedSuspiciousCaptures
  }

  get introWaitCount(): number {
    return this.introWaits
  }

  get introNaturalResolutionCount(): number {
    return this.introNaturalResolutions
  }

  get averageIntroWaitMs(): number {
    return this.introWaits > 0 ? Math.round(this.introWaitTotalMs / this.introWaits) : 0
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
    this.visualSettleComplexCount = 0
    this.visualSettleCommandFailures = 0
    this.loaderBypasses = 0
    this.cookieCleanupActions = 0
    this.cookieGuardActions = 0
    this.captureRecoveries = 0
    this.unresolvedSuspiciousCaptures = 0
    this.introWaits = 0
    this.introNaturalResolutions = 0
    this.introWaitTotalMs = 0
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
              features: [{ name: 'prefers-color-scheme', value: 'light' }]
            },
            sessionId
          ),
          runtime.connection.send(
            'Page.addScriptToEvaluateOnNewDocument',
            {
              source: COOKIE_GUARD_BOOTSTRAP_SCRIPT
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
                scrollTo(0, 0);
                dispatchEvent(new Event('resize'));
                dispatchEvent(new Event('scroll'));
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
        let visualSettleCommandFailed = false
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
          .catch(() => {
            visualSettleCommandFailed = true
            return { result: { value: null } }
          })
        const visualSettleMs = performance.now() - visualSettleStartedAt
        const settleValue = settleResponse.result?.value
        const settleRecord =
          settleValue && typeof settleValue === 'object'
            ? (settleValue as {
                maxedOut?: unknown
                complex?: unknown
                loaderBypasses?: unknown
                title?: unknown
              })
            : null

        this.visualSettleTotalMs += visualSettleMs
        this.visualSettleCount++

        if (visualSettleCommandFailed) {
          this.visualSettleCommandFailures++
        }

        if (settleRecord?.maxedOut === true) {
          this.visualSettleMaxOuts++
        }

        if (settleRecord?.complex === true) {
          this.visualSettleComplexCount++
        }

        if (typeof settleRecord?.loaderBypasses === 'number') {
          this.loaderBypasses += settleRecord.loaderBypasses
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

        const guardStatusResponse = await runtime.connection
          .send<{
            result?: {
              value?: unknown
            }
          }>(
            'Runtime.evaluate',
            {
              expression: COOKIE_GUARD_STATUS_SCRIPT,
              returnByValue: true
            },
            sessionId,
            PAINT_READY_TIMEOUT_MS + 100
          )
          .catch(() => ({ result: { value: 0 } }))
        const guardActions =
          typeof guardStatusResponse.result?.value === 'number'
            ? guardStatusResponse.result.value
            : 0

        this.cookieGuardActions += guardActions

        const settleNeedsRepaint =
          settleRecord?.maxedOut === true ||
          (typeof settleRecord?.loaderBypasses === 'number' && settleRecord.loaderBypasses > 0)

        if (lateCleanupActions > 0) {
          await delay(180)
        } else if (settleNeedsRepaint) {
          await delay(120)
        }

        if (cancelled) {
          throw new Error('Local browser render cancelled')
        }

        stage = 'capture health'
        let healthRecord = await this.evaluateCaptureHealth(runtime.connection, sessionId)

        if (healthRecord?.suspicious === true && this.shouldWaitForNaturalIntro(healthRecord)) {
          stage = 'intro wait'
          this.introWaits++
          const introWaitStartedAt = performance.now()

          healthRecord = await this.waitForNaturalIntro(
            runtime.connection,
            sessionId,
            navigationStartedAt,
            healthRecord
          )

          this.introWaitTotalMs += performance.now() - introWaitStartedAt

          if (healthRecord?.suspicious !== true) {
            this.introNaturalResolutions++
          }
        }

        if (healthRecord?.suspicious === true) {
          this.captureRecoveries++
          stage = 'capture recovery'

          await runtime.connection
            .send(
              'Runtime.evaluate',
              {
                expression: `(() => {
                  let actions = 0;
                  actions += ${COOKIE_CLEANUP_SCRIPT};
                  actions += ${CAPTURE_RECOVERY_SCRIPT};
                  return actions;
                })()`,
                returnByValue: true
              },
              sessionId,
              CAPTURE_HEALTH_COMMAND_TIMEOUT_MS
            )
            .catch(() => null)

          await delay(CAPTURE_RECOVERY_WAIT_MS)
          healthRecord = await this.evaluateCaptureHealth(runtime.connection, sessionId)

          if (healthRecord?.suspicious === true) {
            this.unresolvedSuspiciousCaptures++
          }
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

  private async evaluateCaptureHealth(
    connection: CdpConnection,
    sessionId: string
  ): Promise<CaptureHealthRecord | null> {
    const response = await connection
      .send<{
        result?: {
          value?: unknown
        }
      }>(
        'Runtime.evaluate',
        {
          expression: CAPTURE_HEALTH_SCRIPT,
          returnByValue: true
        },
        sessionId,
        CAPTURE_HEALTH_COMMAND_TIMEOUT_MS
      )
      .catch(() => ({ result: { value: null } }))
    const value = response.result?.value

    return value && typeof value === 'object' ? (value as CaptureHealthRecord) : null
  }

  private shouldWaitForNaturalIntro(health: CaptureHealthRecord): boolean {
    if (!Array.isArray(health.reasons)) return false

    return health.reasons.some(
      reason => typeof reason === 'string' && NATURAL_INTRO_REASONS.has(reason)
    )
  }

  private async waitForNaturalIntro(
    connection: CdpConnection,
    sessionId: string,
    navigationStartedAt: number,
    initialHealth: CaptureHealthRecord
  ): Promise<CaptureHealthRecord | null> {
    const deadline = navigationStartedAt + CAPTURE_INTRO_MAX_FROM_NAVIGATION_MS
    let latestHealth: CaptureHealthRecord | null = initialHealth
    let healthyPasses = 0

    while (performance.now() < deadline) {
      const remainingMs = deadline - performance.now()

      await delay(Math.min(CAPTURE_INTRO_POLL_MS, Math.max(1, remainingMs)))

      latestHealth = await this.evaluateCaptureHealth(connection, sessionId)

      if (latestHealth?.suspicious === true) {
        healthyPasses = 0

        if (!this.shouldWaitForNaturalIntro(latestHealth)) {
          return latestHealth
        }

        continue
      }

      healthyPasses++

      if (healthyPasses >= 2) {
        return latestHealth
      }
    }

    return latestHealth
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
      '--autoplay-policy=no-user-gesture-required',
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
