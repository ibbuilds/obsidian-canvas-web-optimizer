import { around } from 'monkey-around'
import {
  type Canvas,
  type CanvasLeaf,
  type CanvasNodeData,
  debounce,
  type LinkNodeConstructor,
  Notice,
  Plugin
} from 'obsidian'

const THUMBNAIL_JPEG_QUALITY = 100

const RESIZE_DEBOUNCE_MS = 500

const PREVIEW_TRANSITION_FALLBACK_MS = 250
const WEBVIEW_PAINT_SETTLE_MS = 100

const CAPTURE_MAX_WAIT_MS = 4000
const IMAGE_DECODE_TIMEOUT_MS = 2500
const ANIMATION_TIMEOUT_MS = 3000
const MAX_FINITE_ANIMATION_MS = 3500
const FINAL_SETTLE_MAX_MS = 750

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

const CAPTURE_READY_SCRIPT = `
  (() => {
    const timeout = ms =>
      new Promise(resolve => setTimeout(resolve, ms))

    const waitForImages = async () => {
      const images = [...document.images].filter(img => {
        const rect = img.getBoundingClientRect()

        return (
          rect.width > 0 &&
          rect.height > 0 &&
          !img.complete
        )
      })

      await Promise.allSettled(
        images.map(img =>
          Promise.race([
            img.decode?.() ?? Promise.resolve(),
            timeout(${IMAGE_DECODE_TIMEOUT_MS})
          ])
        )
      )
    }

    const waitForAnimations = async () => {
      const animations = document
        .getAnimations()
        .filter(animation => {
          const timing = animation.effect?.getComputedTiming()

          return (
            animation.playState !== 'finished' &&
            Number.isFinite(timing?.endTime) &&
            timing.endTime <= ${MAX_FINITE_ANIMATION_MS}
          )
        })

      await Promise.allSettled(
        animations.map(animation =>
          Promise.race([
            animation.finished.catch(() => {}),
            timeout(${ANIMATION_TIMEOUT_MS})
          ])
        )
      )
    }

    const ready = async () => {
      const started = performance.now()

      await Promise.allSettled([
        document.fonts?.ready ?? Promise.resolve(),
        waitForImages(),
        waitForAnimations()
      ])

      const elapsed = performance.now() - started

      const remaining = Math.max(
        0,
        Math.min(
          ${FINAL_SETTLE_MAX_MS},
          ${CAPTURE_MAX_WAIT_MS} - elapsed
        )
      )

      if (remaining > 0) {
        await timeout(remaining)
      }

      await new Promise(resolve =>
        requestAnimationFrame(() =>
          requestAnimationFrame(resolve)
        )
      )
    }

    return Promise.race([
      ready(),
      timeout(${CAPTURE_MAX_WAIT_MS})
    ])
  })()
`

function afterTransition(element: HTMLElement, callback: () => void) {
  let finished = false

  const finish = () => {
    if (finished) return

    finished = true
    callback()
  }

  element.addEventListener('transitionend', finish, {
    once: true
  })

  window.setTimeout(finish, PREVIEW_TRANSITION_FALLBACK_MS)
}

export default class CanvasWebOptimizerPlugin extends Plugin {
  name = 'Canvas Web Optimizer'

  cacheDir = `${this.manifest.dir}/data/linkCache`

  cacheHits = 0
  cacheMisses = 0
  generatingThumbnails = 0

  deactivateActiveWebview: (() => void) | null = null

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

    this.registerEvent(
      this.app.workspace.on(`${this.manifest.id}:patched-canvas`, () => {
        this.reloadActiveCanvasViews()
      })
    )

    await this.app.vault.adapter.mkdir(this.cacheDir)

    this.app.workspace.onLayoutReady(() => {
      if (this.tryPatchLinkNode()) return

      const evt = this.app.workspace.on('layout-change', () => {
        if (!this.tryPatchLinkNode()) return

        this.app.workspace.offref(evt)
      })

      this.registerEvent(evt)
    })

    this.log('Plugin loaded')
  }

  onunload() {
    this.log('Unloading plugin')

    this.reloadActiveCanvasViews()

    this.deactivateActiveWebview?.()
    this.deactivateActiveWebview = null
  }

  reloadActiveCanvasViews() {
    this.app.workspace.getLeavesOfType('canvas').forEach(leaf => {
      leaf.rebuildView()
    })
  }

  log(msg: unknown, debug = false) {
    if (debug) {
      console.debug(`[${this.name}]`, msg)
      return
    }

    console.log(`[${this.name}]`, msg)
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
          const frameEl = this.frameEl

          if (!frameEl?.isConnected) return

          thisPlugin.generatingThumbnails++

          try {
            thisPlugin.log(`Saving thumbnail for ${this.url}`)

            const img = await frameEl.capturePage()

            if (this.frameEl !== frameEl || !frameEl.isConnected || img.isEmpty()) {
              return
            }

            await this.app.vault.adapter.writeBinary(
              this._getThumbnailPath(),
              img.toJPEG(THUMBNAIL_JPEG_QUALITY)
            )
          } catch (error) {
            thisPlugin.log(error, true)
          } finally {
            thisPlugin.generatingThumbnails--
          }
        },

      _getThumbnailPath: () =>
        function () {
          return `${thisPlugin.cacheDir}/${this.id}.thumbnail.jpg`
        },

      _getMetadataPath: () =>
        function () {
          return `${thisPlugin.cacheDir}/${this.id}.metadata.json`
        },

      updateBreakpoint: () =>
        function () {
          this.mountContent()
        },

      initialize: (next: (...args: unknown[]) => unknown) =>
        function (...args: unknown[]) {
          this._initializing = true

          const result = next.call(this, ...args)

          this._initializing = false

          const saveThumbnail = debounce(() => this._saveThumbnail(), RESIZE_DEBOUNCE_MS)

          const resizeObserver = new MutationObserver(mutationList => {
            for (const mutation of mutationList) {
              if (mutation.type !== 'attributes' || mutation.attributeName !== 'style') {
                continue
              }

              const target = mutation.target as HTMLElement

              const newWidth = target.style.width
              const newHeight = target.style.height

              const oldValue = mutation.oldValue || ''

              const oldWidthMatch = oldValue.match(/width:\s*([^;]+)(;|$)/)

              const oldHeightMatch = oldValue.match(/height:\s*([^;]+)(;|$)/)

              const oldWidth = oldWidthMatch ? oldWidthMatch[1].trim() : ''

              const oldHeight = oldHeightMatch ? oldHeightMatch[1].trim() : ''

              if (!oldWidth || !oldHeight || !newWidth || !newHeight) {
                return
              }

              if (newWidth === oldWidth && newHeight === oldHeight) {
                return
              }

              saveThumbnail()
            }
          })

          resizeObserver.observe(this.nodeEl, {
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ['style']
          })

          ;(async () => {
            const revealWebview = () => {
              thisPlugin.deactivateActiveWebview?.()

              this._previewImageEl?.classList.remove('link-thumbnail-enter', 'link-thumbnail-exit')

              this.recreateFrame()

              thisPlugin.deactivateActiveWebview = () => {
                const frameEl = this.frameEl

                if (!frameEl) return

                const preview = this.contentEl.doc.createElement('img')

                preview.classList.add('link-thumbnail', 'link-thumbnail-enter')

                preview.alt = 'Webpage thumbnail'

                preview.src = thisPlugin.app.vault.adapter.getResourcePath(this._getThumbnailPath())

                this.contentEl.append(preview)

                this._previewImageEl = preview

                const finish = () => {
                  if (this._previewImageEl !== preview || !preview.isConnected) {
                    return
                  }

                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      if (this._previewImageEl !== preview) {
                        return
                      }

                      preview.classList.remove('link-thumbnail-enter')

                      afterTransition(preview, () => {
                        if (this.frameEl === frameEl) {
                          frameEl.remove()
                          this.frameEl = null
                        }
                      })
                    })
                  })
                }

                if (preview.complete) {
                  finish()
                  return
                }

                preview.addEventListener('load', finish, { once: true })

                preview.addEventListener(
                  'error',
                  () => {
                    preview.remove()

                    if (this._previewImageEl === preview) {
                      this._previewImageEl = null
                    }
                  },
                  { once: true }
                )
              }
            }

            const activateFromThumbnail = (event: PointerEvent) => {
              if (event.button !== 0 || !this._previewImageEl) {
                return
              }

              event.preventDefault()
              event.stopImmediatePropagation()

              revealWebview()
            }

            this.nodeEl.addEventListener('pointerdown', activateFromThumbnail, true)

            const [thumbnailExists, metadataExists] = await Promise.all([
              thisPlugin.app.vault.exists(this._getThumbnailPath()),
              thisPlugin.app.vault.exists(this._getMetadataPath())
            ])

            if (!thumbnailExists || !metadataExists) {
              thisPlugin.cacheMisses++

              this.recreateFrame()

              return
            }

            thisPlugin.cacheHits++

            const metadataRaw = await thisPlugin.app.vault.adapter.read(this._getMetadataPath())

            const metadata = JSON.parse(metadataRaw)

            this.updateNodeLabel(metadata.title)

            this._previewImageEl = this.contentEl.doc.createElement('img')

            this.contentEl.append(this._previewImageEl)

            this._previewImageEl.classList.add('link-thumbnail')

            this._previewImageEl.alt = 'Webpage thumbnail'

            this._previewImageEl.src = thisPlugin.app.vault.adapter.getResourcePath(
              this._getThumbnailPath()
            )

            this._previewImageEl.addEventListener('error', revealWebview)
          })()

          return result
        },

      recreateFrame: (next: (...args: unknown[]) => unknown) =>
        function (...args: unknown[]) {
          if (this._initializing) return null

          const result = next.call(this, ...args)

          if (this.frameEl?.tagName !== 'WEBVIEW') {
            return result
          }

          const frameEl = this.frameEl

          const applyLightTheme = async () => {
            if (!frameEl.isConnected) return

            try {
              await frameEl.insertCSS(LIGHT_THEME_CSS)

              await frameEl.executeJavaScript(LIGHT_THEME_SCRIPT)
            } catch {
              // Best effort.
            }
          }

          frameEl.addEventListener('dom-ready', applyLightTheme)

          const onFrameLoaded = async () => {
            frameEl.removeEventListener('did-finish-load', onFrameLoaded)

            if (this.frameEl !== frameEl || !frameEl.isConnected) {
              return
            }

            try {
              await frameEl.executeJavaScript(WEBVIEW_PAINT_READY_SCRIPT)

              await frameEl.capturePage()
            } catch {
              // Best effort.
            }

            await sleep(WEBVIEW_PAINT_SETTLE_MS)

            if (this.frameEl !== frameEl || !frameEl.isConnected) {
              return
            }

            const preview = this._previewImageEl

            if (preview?.isConnected) {
              preview.classList.add('link-thumbnail-exit')

              afterTransition(preview, () => {
                if (this._previewImageEl === preview) {
                  preview.remove()

                  this._previewImageEl = null
                }
              })
            }

            try {
              await frameEl.executeJavaScript(CAPTURE_READY_SCRIPT)
            } catch {
              // Best effort.
            }

            if (this.frameEl !== frameEl || !frameEl.isConnected) {
              return
            }

            await this.app.vault.adapter.write(
              this._getMetadataPath(),
              JSON.stringify({
                title: frameEl.getTitle()
              })
            )

            await this._saveThumbnail()

            thisPlugin.log(`Cached link ${this.url}`)
          }

          frameEl.addEventListener('did-finish-load', onFrameLoaded)

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

    return dummyLinkNode.constructor
  }

  showDiagnostics() {
    const canvasLeaves = this.app.workspace.getLeavesOfType('canvas') as CanvasLeaf[]

    let cachedPreviews = 0
    let liveWebviews = 0

    for (const leaf of canvasLeaves) {
      cachedPreviews += leaf.view.containerEl.querySelectorAll('.link-thumbnail').length

      liveWebviews += leaf.view.containerEl.querySelectorAll('webview').length
    }

    const webCards = cachedPreviews + liveWebviews

    const diagnostics = [
      `Web cards: ${webCards}`,
      `Cached previews: ${cachedPreviews}`,
      `Live webviews: ${liveWebviews}`,
      `Generating thumbnails: ${this.generatingThumbnails}`,
      'Queued: 0',
      `Cache hits: ${this.cacheHits}`,
      `Cache misses: ${this.cacheMisses}`
    ].join('\n')

    this.log(diagnostics)

    new Notice(diagnostics, 10000)
  }

  async cleanupThumbnails() {
    const thumbnails = await this.app.vault.adapter.list(this.cacheDir)

    const thumbnailFiles = thumbnails.files.filter(file => file.endsWith('.thumbnail.jpg'))

    const nodeIds = thumbnailFiles
      .map(file => {
        const match = file.match(/([^/]+)\.thumbnail\.jpg$/)

        return match ? match[1] : undefined
      })
      .filter((nodeId): nodeId is string => nodeId !== undefined)

    const canvasFiles = this.app.vault.getFiles().filter(file => file.path.endsWith('.canvas'))

    const usedNodeIds = new Set<string>()

    for (const canvasFile of canvasFiles) {
      const content = await this.app.vault.read(canvasFile)

      const nodes = this.extractNodeIdsFromCanvas(content)

      nodes.forEach(nodeId => {
        usedNodeIds.add(nodeId)
      })
    }

    const unusedNodeIds = nodeIds.filter(nodeId => !usedNodeIds.has(nodeId))

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
    }

    new Notice(`${unusedNodeIds.length} Unused thumbnails cleaned up!`)
  }

  extractNodeIdsFromCanvas(content: string): string[] {
    const canvas = JSON.parse(content)

    return (canvas.nodes || []).map((node: CanvasNodeData) => node.id)
  }
}
