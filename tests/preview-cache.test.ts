import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import type { App } from 'obsidian'
import PreviewCache, { CACHE_METADATA_VERSION } from '../src/cache/preview-cache'

type Stored = string | ArrayBuffer

function createFakeApp() {
  const files = new Map<string, Stored>()

  const adapter = {
    async mkdir(_path: string) {},
    async exists(path: string) {
      return files.has(path)
    },
    async read(path: string) {
      const value = files.get(path)

      if (typeof value !== 'string') throw new Error(`Expected text file: ${path}`)

      return value
    },
    async write(path: string, value: string) {
      files.set(path, value)
    },
    async writeBinary(path: string, value: ArrayBuffer) {
      files.set(path, value)
    },
    async remove(path: string) {
      files.delete(path)
    },
    async list(directory: string) {
      return {
        files: [...files.keys()].filter(path => path.startsWith(`${directory}/`)),
        folders: []
      }
    },
    getResourcePath(path: string) {
      return `app://local/${path}`
    }
  }

  return {
    app: {
      vault: {
        adapter
      }
    } as unknown as App,
    files
  }
}

test('PreviewCache owns thumbnail and metadata index state', async () => {
  const { app, files } = createFakeApp()
  const cache = new PreviewCache(app, 'cache', () => {})

  await cache.initialize()

  const metadata = {
    version: CACHE_METADATA_VERSION,
    url: 'https://example.com',
    title: 'Example',
    capturedAt: 1
  }

  await cache.writeThumbnail('node-a', new Uint8Array([1, 2, 3]).buffer)
  await cache.writeMetadata('node-a', metadata)

  assert.equal(cache.has('node-a'), true)
  assert.deepEqual(await cache.readMetadata('node-a'), metadata)
  assert.equal(cache.thumbnailPath('node-a'), 'cache/node-a.thumbnail.jpg')
  assert.equal(cache.metadataPath('node-a'), 'cache/node-a.metadata.json')
  assert.equal(cache.resourcePath('node-a'), 'app://local/cache/node-a.thumbnail.jpg')

  await cache.remove('node-a')

  assert.equal(cache.has('node-a'), false)
  assert.equal(files.has('cache/node-a.thumbnail.jpg'), false)
  assert.equal(files.has('cache/node-a.metadata.json'), false)
})

test('PreviewCache validates schema and URL before returning metadata', async () => {
  const { app } = createFakeApp()
  const cache = new PreviewCache(app, 'cache', () => {})

  await cache.initialize()

  await cache.writeMetadata('valid', {
    version: CACHE_METADATA_VERSION,
    url: 'https://example.com',
    title: 'Example'
  })
  await cache.writeMetadata('stale-url', {
    version: CACHE_METADATA_VERSION,
    url: 'https://old.example.com',
    title: 'Old'
  })
  await cache.writeMetadata('old-schema', {
    version: CACHE_METADATA_VERSION - 1,
    url: 'https://example.com',
    title: 'Old schema'
  })

  assert.equal((await cache.readValidMetadata('valid', 'https://example.com'))?.title, 'Example')
  assert.equal(await cache.readValidMetadata('stale-url', 'https://example.com'), null)
  assert.equal(await cache.readValidMetadata('old-schema', 'https://example.com'), null)
})

test('PreviewCache cleanup removes only unused node cache', async () => {
  const { app } = createFakeApp()
  const cache = new PreviewCache(app, 'cache', () => {})

  await cache.initialize()

  for (const nodeId of ['keep', 'remove']) {
    await cache.writeThumbnail(nodeId, new Uint8Array([1]).buffer)
    await cache.writeMetadata(nodeId, {
      version: CACHE_METADATA_VERSION,
      title: nodeId
    })
  }

  const removed = await cache.cleanupUnused(new Set(['keep']))

  assert.equal(removed, 1)
  assert.equal(cache.has('keep'), true)
  assert.equal(cache.has('remove'), false)
})
