import type { LinkNode } from 'obsidian'

export type ElectronDebuggerLike = {
  attach(protocolVersion?: string): void
  isAttached(): boolean
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export type ElectronGuestWebContentsLike = {
  debugger: ElectronDebuggerLike
  isDestroyed?(): boolean
}

type ElectronWebContentsModuleLike = {
  fromId(id: number): ElectronGuestWebContentsLike | undefined
}

type ElectronRemoteLike = {
  require?: (specifier: string) => unknown
  webContents?: ElectronWebContentsModuleLike
}

function getRuntimeRequire(): ((specifier: string) => unknown) | null {
  const runtimeGlobal = globalThis as typeof globalThis & {
    require?: (specifier: string) => unknown
  }

  return typeof runtimeGlobal.require === 'function' ? runtimeGlobal.require : null
}

export function resolveGuestWebContents(
  frameEl: LinkNode['frameEl']
): ElectronGuestWebContentsLike | null {
  const id = frameEl?.getWebContentsId?.()

  if (typeof id !== 'number') return null

  const runtimeRequire = getRuntimeRequire()

  if (!runtimeRequire) return null

  try {
    const remote = runtimeRequire('@electron/remote') as ElectronRemoteLike
    const direct = remote.webContents?.fromId(id)

    if (direct) return direct

    const remoteElectron = remote.require?.('electron') as
      | { webContents?: ElectronWebContentsModuleLike }
      | undefined
    const throughRemoteRequire = remoteElectron?.webContents?.fromId(id)

    if (throughRemoteRequire) return throughRemoteRequire
  } catch {
    // Try the renderer Electron export as a last resort below.
  }

  try {
    const electron = runtimeRequire('electron') as {
      webContents?: ElectronWebContentsModuleLike
    }

    return electron.webContents?.fromId(id) ?? null
  } catch {
    return null
  }
}

export function openExternalUrl(url: string): Promise<void> {
  const runtimeRequire = getRuntimeRequire()

  if (!runtimeRequire) {
    return Promise.reject(new Error('Electron runtime is unavailable'))
  }

  try {
    const remote = runtimeRequire('@electron/remote') as {
      shell?: {
        openExternal(target: string): Promise<void>
      }
    }

    if (remote.shell?.openExternal) {
      return remote.shell.openExternal(url)
    }
  } catch {
    // Fall through to the renderer Electron export.
  }

  try {
    const electron = runtimeRequire('electron') as {
      shell?: {
        openExternal(target: string): Promise<void>
      }
    }

    if (electron.shell?.openExternal) {
      return electron.shell.openExternal(url)
    }
  } catch {
    // Report one stable error below.
  }

  return Promise.reject(new Error('Electron shell is unavailable'))
}
