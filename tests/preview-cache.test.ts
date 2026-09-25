import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import PreviewCache, { CACHE_METADATA_VERSION } from '../src/cache/preview-cache'
import { createFakeApp } from './helpers/fake-app'

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
