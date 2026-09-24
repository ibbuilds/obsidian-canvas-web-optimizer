type WarmResponse = {
  ok: boolean
  headers: {
    get(name: string): string | null
  }
  arrayBuffer(): Promise<ArrayBuffer>
}

type PreconnectSession = {
  preconnect(options: { url: string; numSockets?: number }): void
  fetch?(
    input: string,
    init?: {
      method?: string
      credentials?: 'include'
      cache?: 'default'
      redirect?: 'follow'
      headers?: Record<string, string>
    }
  ): Promise<WarmResponse>
}

type SessionModuleLike = {
  fromPartition(partition: string): PreconnectSession
}

type RemoteLike = {
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
    return remote.session?.fromPartition(partition) ?? null
  } catch {
    return null
  }
}

const PRECONNECT_COOLDOWN_MS = 60_000
const MAX_WARM_BODY_BYTES = 1_500_000

export default class NetworkPreconnector {
  private readonly session: PreconnectSession | null
  private readonly preconnectedOrigins = new Map<string, number>()
  private readonly warmingUrls = new Set<string>()
  private readonly warmedUrls = new Set<string>()
  private successfulPreconnects = 0
  private warmStarted = 0
  private warmCompleted = 0
  private warmFailed = 0

  constructor(partition: string | null) {
    this.session = resolveSession(partition)
  }

  get active(): boolean {
    return this.session !== null
  }

  get fetchActive(): boolean {
    return typeof this.session?.fetch === 'function'
  }

  get count(): number {
    return this.successfulPreconnects
  }

  get warmStartedCount(): number {
    return this.warmStarted
  }

  get warmCompletedCount(): number {
    return this.warmCompleted
  }

  get warmFailedCount(): number {
    return this.warmFailed
  }

  resetMetrics() {
    this.successfulPreconnects = 0
    this.warmStarted = 0
    this.warmCompleted = 0
    this.warmFailed = 0
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
        this.session.preconnect({ url: origin, numSockets: 1 })
        this.preconnectedOrigins.set(origin, now)
        this.successfulPreconnects++
        scheduled++
      } catch {
        // Opportunistic only. Normal webview navigation remains unchanged.
      }
    }
  }

  warm(urls: Iterable<string>, maxRequests: number) {
    const fetch = this.session?.fetch

    if (!fetch || maxRequests <= 0) return

    let scheduled = 0

    for (const url of urls) {
      if (scheduled >= maxRequests) break
      if (this.warmingUrls.has(url) || this.warmedUrls.has(url)) continue

      this.warmingUrls.add(url)
      this.warmStarted++
      scheduled++

      void fetch
        .call(this.session, url, {
          method: 'GET',
          credentials: 'include',
          cache: 'default',
          redirect: 'follow',
          headers: {
            Accept: 'text/html,application/xhtml+xml'
          }
        })
        .then(async (response: WarmResponse) => {
          if (!response.ok) {
            this.warmFailed++
            return
          }

          const contentLength = Number(response.headers.get('content-length') ?? 0)

          if (contentLength > MAX_WARM_BODY_BYTES) {
            return
          }

          await response.arrayBuffer()
          this.warmedUrls.add(url)
          this.warmCompleted++
        })
        .catch(() => {
          this.warmFailed++
        })
        .finally(() => {
          this.warmingUrls.delete(url)
        })
    }
  }
}
