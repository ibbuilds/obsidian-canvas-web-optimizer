export type CaptureWorkerImage = {
  getSize(): { width: number; height: number }
  isEmpty(): boolean
  resize(options: { width: number; height: number; quality: 'good' }): CaptureWorkerImage
  toJPEG(quality: number): ArrayBuffer
}

export type CaptureWorkerFrame = HTMLElement & {
  capturePage(): Promise<CaptureWorkerImage>
  executeJavaScript(code: string): Promise<unknown>
  getTitle(): string
  insertCSS(css: string): Promise<string>
  loadURL?(url: string): Promise<void> | void
  setAudioMuted?(muted: boolean): void
  stop?(): void
}

export type CaptureWorker = {
  id: number
  document: Document
  host: HTMLElement
  frame: CaptureWorkerFrame
  busy: boolean
  navigationId: number
  cancelNavigation: (() => void) | null
}

type DidFailLoadEvent = Event & {
  errorCode?: number
  isMainFrame?: boolean
}

const WORKER_CLASS = 'canvas-web-capture-worker'
const WORKER_HOST_CLASS = 'canvas-web-capture-worker-host'
const WORKER_WEB_PREFERENCES = 'backgroundThrottling=no, disableDialogs=yes'

function isFatalLoadFailure(event: DidFailLoadEvent): boolean {
  if (event.isMainFrame === false) return false
  return event.errorCode !== -3
}

export default class CaptureWorkerPool {
  private readonly workers = new Set<CaptureWorker>()
  private nextId = 1
  private createdWorkers = 0
  private reusedWorkers = 0

  constructor(private readonly partition: string | null) {}

  get size(): number {
    return this.workers.size
  }

  get busyCount(): number {
    let count = 0

    for (const worker of this.workers) {
      if (worker.busy) count++
    }

    return count
  }

  get createdCount(): number {
    return this.createdWorkers
  }

  get reusedCount(): number {
    return this.reusedWorkers
  }

  resetMetrics() {
    this.createdWorkers = 0
    this.reusedWorkers = 0
  }

  acquire(document: Document, width: number, height: number): CaptureWorker | null {
    for (const worker of this.workers) {
      if (!worker.busy && worker.document === document && worker.host.isConnected) {
        worker.busy = true
        this.reusedWorkers++
        this.resize(worker, width, height)
        return worker
      }
    }

    const worker = this.createWorker(document)

    if (!worker) return null

    worker.busy = true
    this.createdWorkers++
    this.resize(worker, width, height)
    this.workers.add(worker)

    return worker
  }

  navigate(worker: CaptureWorker, url: string): Promise<void> {
    worker.navigationId++
    const navigationId = worker.navigationId
    worker.cancelNavigation?.()
    worker.frame.stop?.()

    return new Promise((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        worker.frame.removeEventListener('dom-ready', onReady)
        worker.frame.removeEventListener('did-fail-load', onFailed)

        if (worker.cancelNavigation === cancel) {
          worker.cancelNavigation = null
        }
      }

      const finish = (error?: Error) => {
        if (settled) return

        settled = true
        cleanup()

        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      const onReady = () => {
        if (worker.navigationId !== navigationId) return
        finish()
      }

      const onFailed = (event: Event) => {
        if (worker.navigationId !== navigationId) return
        if (!isFatalLoadFailure(event as DidFailLoadEvent)) return

        finish(new Error('Capture worker failed to load page'))
      }

      const cancel = () => {
        finish(new Error('Capture worker navigation cancelled'))
      }

      worker.cancelNavigation = cancel
      worker.frame.addEventListener('dom-ready', onReady, { once: true })
      worker.frame.addEventListener('did-fail-load', onFailed)

      try {
        if (typeof worker.frame.loadURL === 'function') {
          Promise.resolve(worker.frame.loadURL(url)).catch(error => {
            if (worker.navigationId === navigationId) {
              finish(error instanceof Error ? error : new Error(String(error)))
            }
          })
        } else {
          worker.frame.setAttribute('src', url)
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  cancel(worker: CaptureWorker) {
    worker.navigationId++
    worker.frame.stop?.()
    worker.cancelNavigation?.()
    worker.cancelNavigation = null
  }

  release(worker: CaptureWorker) {
    this.cancel(worker)
    worker.busy = false
  }

  disposeIdle() {
    for (const worker of [...this.workers]) {
      if (worker.busy) continue
      this.disposeWorker(worker)
    }
  }

  disposeAll() {
    for (const worker of [...this.workers]) {
      this.disposeWorker(worker)
    }
  }

  private createWorker(document: Document): CaptureWorker | null {
    if (!this.partition || !document.body) return null

    try {
      const host = document.createElement('div')
      const frame = document.createElement('webview') as CaptureWorkerFrame
      const userAgent = document.defaultView?.navigator.userAgent

      host.classList.add(WORKER_HOST_CLASS)
      frame.classList.add(WORKER_CLASS)

      frame.setAttribute('partition', this.partition)
      frame.setAttribute('webpreferences', WORKER_WEB_PREFERENCES)
      frame.setAttribute('target', '_self')

      if (userAgent) {
        frame.setAttribute('useragent', userAgent)
      }

      frame.style.width = '100%'
      frame.style.height = '100%'
      host.append(frame)
      document.body.append(host)

      if (
        typeof frame.capturePage !== 'function' ||
        typeof frame.executeJavaScript !== 'function' ||
        typeof frame.insertCSS !== 'function'
      ) {
        host.remove()
        return null
      }

      frame.setAudioMuted?.(true)

      return {
        id: this.nextId++,
        document,
        host,
        frame,
        busy: false,
        navigationId: 0,
        cancelNavigation: null
      }
    } catch {
      return null
    }
  }

  private resize(worker: CaptureWorker, width: number, height: number) {
    worker.host.style.width = `${Math.max(1, Math.round(width))}px`
    worker.host.style.height = `${Math.max(1, Math.round(height))}px`
  }

  private disposeWorker(worker: CaptureWorker) {
    this.cancel(worker)
    worker.frame.remove()
    worker.host.remove()
    this.workers.delete(worker)
  }
}
