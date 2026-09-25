import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import PreviewCache, { CACHE_METADATA_VERSION } from '../src/cache/preview-cache'
import DynamicPriorityQueue from '../src/generation/dynamic-priority-queue'
import GenerationCoordinator from '../src/generation/coordinator'
import { createFakeApp } from './helpers/fake-app'

type Job = {
  id: string
  priority: number
  valid: boolean
}

test('generation queue stays coherent across five thousand jobs and reprioritization', () => {
  const queue = new DynamicPriorityQueue<Job>(
    job => job.id,
    job => job.priority,
    job => job.valid
  )
  const jobs: Job[] = []

  for (let index = 0; index < 5000; index++) {
    const job = {
      id: `job-${index}`,
      priority: index % 3,
      valid: true
    }

    jobs.push(job)
    assert.equal(queue.enqueue(job), true)
  }

  for (let index = 0; index < 1000; index++) {
    assert.ok(queue.remove(`job-${index * 3}`))
  }

  for (const job of jobs) {
    if (job.id.endsWith('7')) {
      job.priority = 0
    }
  }

  queue.markPrioritiesDirty()

  const remaining = queue.values()
  assert.equal(remaining.length, 4000)
  assert.equal(new Set(remaining.map(job => job.id)).size, 4000)

  let drained = 0

  while (queue.dequeue()) {
    drained++
  }

  assert.equal(drained, 4000)
  assert.equal(queue.length, 0)
})

test('generation coordinator prevents duplicate work across a thousand keyed jobs', () => {
  const coordinator = new GenerationCoordinator<Job>({
    getKey: job => job.id,
    getPriority: job => job.priority,
    isValid: job => job.valid,
    process: () => {}
  })

  for (let index = 0; index < 1000; index++) {
    const job = { id: `job-${index}`, priority: index % 3, valid: true }

    assert.equal(coordinator.enqueue(job), true)
    assert.equal(coordinator.enqueue(job), false)
  }

  assert.equal(coordinator.length, 1000)

  const ids = coordinator.values().map(job => job.id)
  assert.equal(new Set(ids).size, 1000)

  coordinator.clear()
  assert.equal(coordinator.length, 0)
})

test('preview cache indexes and cleans a thousand-node synthetic Canvas cache', async () => {
  const { app, files } = createFakeApp()
  const cache = new PreviewCache(app, 'cache', () => {})

  await cache.initialize()

  for (let index = 0; index < 1000; index++) {
    const nodeId = `node-${index}`

    await cache.writeThumbnail(nodeId, new Uint8Array([index % 255]).buffer)
    await cache.writeMetadata(nodeId, {
      version: CACHE_METADATA_VERSION,
      url: `https://example.com/${index}`,
      title: `Node ${index}`,
      capturedAt: index
    })
  }

  const keep = new Set(Array.from({ length: 500 }, (_, index) => `node-${index * 2}`))
  const removed = await cache.cleanupUnused(keep)

  assert.equal(removed, 500)

  for (const nodeId of keep) {
    assert.equal(cache.has(nodeId), true)
  }

  assert.equal(
    [...files.keys()].filter(path => path.endsWith('.thumbnail.jpg')).length,
    500
  )
  assert.equal(
    [...files.keys()].filter(path => path.endsWith('.metadata.json')).length,
    500
  )
})
