type BackgroundThrottlingTarget = {
  getBackgroundThrottling(): boolean
  setBackgroundThrottling(allowed: boolean): void
  isDestroyed?(): boolean
}

type ElectronWindowLike = {
  webContents?: BackgroundThrottlingTarget
}

type ObsidianWindowLike = Window & {
  electronWindow?: ElectronWindowLike
}

type ElectronRemoteLike = {
  getCurrentWebContents(): BackgroundThrottlingTarget
}

const NOOP_RELEASE = () => {}

function getRuntimeRequire(): ((specifier: string) => unknown) | null {
  const runtimeGlobal = globalThis as typeof globalThis & {
    require?: (specifier: string) => unknown
  }

  return typeof runtimeGlobal.require === 'function' ? runtimeGlobal.require : null
}

function resolveTarget(ownerWindow: Window | null): BackgroundThrottlingTarget | null {
  const electronWindow = (ownerWindow as ObsidianWindowLike | null)?.electronWindow
  const windowTarget = electronWindow?.webContents

  if (windowTarget) return windowTarget

  const runtimeRequire = getRuntimeRequire()

  if (!runtimeRequire) return null

  try {
    const remote = runtimeRequire('@electron/remote') as ElectronRemoteLike
    return remote.getCurrentWebContents()
  } catch {
    return null
  }
}

export default class BackgroundExecutionController {
  private target: BackgroundThrottlingTarget | null = null
  private originalAllowed: boolean | null = null
  private leaseCount = 0
  private warnedUnavailable = false

  get active(): boolean {
    return this.target !== null && this.leaseCount > 0
  }

  acquire(ownerWindow: Window | null): () => void {
    const target = resolveTarget(ownerWindow)

    if (!target || target.isDestroyed?.()) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true
        console.warn('[Canvas Web Optimizer] Unable to disable Electron background throttling.')
      }

      return NOOP_RELEASE
    }

    if (this.target && this.target !== target) {
      this.restore()
    }

    if (!this.target) {
      this.target = target
      this.originalAllowed = target.getBackgroundThrottling()

      if (this.originalAllowed) {
        target.setBackgroundThrottling(false)
      }
    }

    this.leaseCount += 1

    let released = false

    return () => {
      if (released) return

      released = true
      this.leaseCount = Math.max(0, this.leaseCount - 1)

      if (this.leaseCount === 0) {
        this.restore()
      }
    }
  }

  dispose() {
    this.leaseCount = 0
    this.restore()
  }

  private restore() {
    const target = this.target
    const originalAllowed = this.originalAllowed

    this.target = null
    this.originalAllowed = null
    this.leaseCount = 0

    if (!target || originalAllowed === null || target.isDestroyed?.()) return

    try {
      if (target.getBackgroundThrottling() !== originalAllowed) {
        target.setBackgroundThrottling(originalAllowed)
      }
    } catch (error) {
      console.debug('[Canvas Web Optimizer] Failed to restore background throttling.', error)
    }
  }
}
