import type { App } from 'obsidian'

export const CACHE_METADATA_VERSION = 2
const CACHE_SCHEMA_VERSION = 2
const CACHE_SCHEMA_FILENAME = 'cache-schema.json'

export type CacheMetadata = {
  version?: number
  url?: string
  title: string
  capturedAt?: number
}

type Log = (message: unknown, debug?: boolean) => void

export default class PreviewCache {
  private readonly thumbnailIds = new Set<string>()
  private readonly metadataIds = new Set<string>()
  private readonly metadataMemory = new Map<string, CacheMetadata>()

  constructor(
    private readonly app: App,
    readonly directory: string,
    private readonly log: Log
  ) {}

  thumbnailPath(nodeId: string): string {
    return `${this.directory}/${nodeId}.thumbnail.jpg`
  }

  metadataPath(nodeId: string): string {
    return `${this.directory}/${nodeId}.metadata.json`
  }

  resourcePath(nodeId: string): string {
    return this.app.vault.adapter.getResourcePath(this.thumbnailPath(nodeId))
  }

  has(nodeId: string): boolean {
    return this.thumbnailIds.has(nodeId) && this.metadataIds.has(nodeId)
  }

  async initialize() {
    await this.app.vault.adapter.mkdir(this.directory)
    await this.ensureSchema()
    await this.buildIndex()
  }

  async readMetadata(nodeId: string): Promise<CacheMetadata> {
    const cached = this.metadataMemory.get(nodeId)

    if (cached) return cached

    const raw = await this.app.vault.adapter.read(this.metadataPath(nodeId))
    const metadata = JSON.parse(raw) as CacheMetadata

    this.metadataMemory.set(nodeId, metadata)

    return metadata
  }

  markPresent(nodeId: string, metadata: CacheMetadata) {
    this.thumbnailIds.add(nodeId)
    this.metadataIds.add(nodeId)
    this.metadataMemory.set(nodeId, metadata)
  }

  forget(nodeId: string) {
    this.thumbnailIds.delete(nodeId)
    this.metadataIds.delete(nodeId)
    this.metadataMemory.delete(nodeId)
  }

  async writeThumbnail(nodeId: string, jpeg: ArrayBuffer) {
    await this.app.vault.adapter.writeBinary(this.thumbnailPath(nodeId), jpeg)
    this.thumbnailIds.add(nodeId)
  }

  async writeMetadata(nodeId: string, metadata: CacheMetadata) {
    await this.app.vault.adapter.write(this.metadataPath(nodeId), JSON.stringify(metadata))
    this.metadataIds.add(nodeId)
    this.metadataMemory.set(nodeId, metadata)
  }

  async remove(nodeId: string) {
    const removeFile = async (path: string) => {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path)
      }
    }

    await Promise.allSettled([
      removeFile(this.thumbnailPath(nodeId)),
      removeFile(this.metadataPath(nodeId))
    ])

    this.forget(nodeId)
  }

  async cleanupUnused(usedNodeIds: Set<string>): Promise<number> {
    const cachedNodeIds = new Set([...this.thumbnailIds, ...this.metadataIds])
    const unusedNodeIds = [...cachedNodeIds].filter(nodeId => !usedNodeIds.has(nodeId))

    for (const nodeId of unusedNodeIds) {
      this.log(`Removing cache for missing node ${nodeId}`)
      await this.remove(nodeId)
    }

    return unusedNodeIds.length
  }

  private async ensureSchema() {
    const schemaPath = `${this.directory}/${CACHE_SCHEMA_FILENAME}`
    let currentVersion = 0

    try {
      if (await this.app.vault.adapter.exists(schemaPath)) {
        const raw = await this.app.vault.adapter.read(schemaPath)
        const parsed = JSON.parse(raw) as { version?: number }
        currentVersion = parsed.version ?? 0
      }
    } catch (error) {
      this.log(error, true)
    }

    if (currentVersion === CACHE_SCHEMA_VERSION) return

    const listing = await this.app.vault.adapter.list(this.directory)
    const staleFiles = listing.files.filter(path =>
      /(?:\.thumbnail\.jpg|\.metadata\.json|\/url-index\.json)$/.test(path)
    )

    await Promise.all(
      staleFiles.map(async path => {
        try {
          await this.app.vault.adapter.remove(path)
        } catch (error) {
          this.log(error, true)
        }
      })
    )

    await this.app.vault.adapter.write(
      schemaPath,
      JSON.stringify({
        version: CACHE_SCHEMA_VERSION,
        migratedAt: Date.now()
      })
    )
  }

  private async buildIndex() {
    const listing = await this.app.vault.adapter.list(this.directory)

    for (const path of listing.files) {
      const thumbnailMatch = path.match(/([^/]+)\.thumbnail\.jpg$/)

      if (thumbnailMatch) {
        this.thumbnailIds.add(thumbnailMatch[1])
        continue
      }

      const metadataMatch = path.match(/([^/]+)\.metadata\.json$/)

      if (metadataMatch) {
        this.metadataIds.add(metadataMatch[1])
      }
    }
  }
}
