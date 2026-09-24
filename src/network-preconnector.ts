type PreconnectSession = {
  preconnect(options: { url: string; numSockets?: number }): void
}

type SessionModuleLike = {
  fromPartition(partition: string): PreconnectSession
}

type RemoteLike = {
  session?: SessionModuleLike
}

type ElectronLike = {
  session?: SessionModuleLike
}

function getRuntimeRequire(): ((specifier: string) => unknown) | null {
  const runtimeGlobal = globalThis as typeof globalThis & {
    require?: (specifier: string) => unknown
  }

  return typeof runtimeGlobal.require === 'function' ? runtimeGlobal.require : null
}

function resolveSession(partition: string | null): PreconnectSession | null {
  if (!partition) return null

  const runtimeRequire = getRuntimeRequire()

  if (!runtimeRequire) return null

  try {
    const remote = runtimeRequire('@electron/remote') as RemoteLike
    const session = remote.session?.fromPartition(partition)

    if (session) return session
  } catch {
    // Fall through to Electron's direct module when available.
  }

  try {
    const electron = runtimeRequire('electron') as ElectronLike
    return electron.session?.fromPartition(partition) ?? null
  } catch {
    return null
  }
}

const PRECONNECT_COOLDOWN_MS = 60_000

export default class NetworkPreconnector {
  private readonly session: PreconnectSession | null
  private readonly preconnectedOrigins = new Map<string, number>()
  private successfulPreconnects = 0

  get active(): boolean {
    return this.session !== null
  }

  get count(): number {
    return this.successfulPreconnects
  }

  resetMetrics() {
    this.successfulPreconnects = 0
  }

  constructor(partition: string | null) {
    this.session = resolveSession(partition)
  }

  preconnect(urls: Iterable<string>, maxOrigins: number) {
    if (!this.session || maxOrigins <= 0) return

    let scheduled = 0

    for (const url of urls) {
      if (scheduled >= maxOrigins) break

      let origin: string

      try {
        origin = new URL(url).origin
      } catch {
        continue
      }

      if (origin === 'null') continue

      const now = Date.now()
      const previous = this.preconnectedOrigins.get(origin)

      if (previous !== undefined && now - previous < PRECONNECT_COOLDOWN_MS) {
        continue
      }

      try {
        this.session.preconnect({
          url: origin,
          numSockets: 1
        })
        this.preconnectedOrigins.set(origin, now)
        this.successfulPreconnects++
        scheduled++
      } catch {
        // Preconnect is opportunistic; navigation remains the fallback.
      }
    }
  }
}
