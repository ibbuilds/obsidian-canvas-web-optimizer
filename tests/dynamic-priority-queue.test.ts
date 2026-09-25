import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import DynamicPriorityQueue from '../src/generation/dynamic-priority-queue'

type Job = {
  id: string
  priority: number
  valid: boolean
  native: boolean
}

function createQueue() {
  return new DynamicPriorityQueue<Job>(
    job => job.id,
    job => job.priority,
    job => job.valid
  )
}

test('dynamic priority queue preserves FIFO order inside the same priority', () => {
  const queue = createQueue()

  queue.enqueue({ id: 'a', priority: 1, valid: true, native: false })
  queue.enqueue({ id: 'b', priority: 1, valid: true, native: false })
  queue.enqueue({ id: 'c', priority: 1, valid: true, native: false })

  assert.equal(queue.dequeue()?.id, 'a')
  assert.equal(queue.dequeue()?.id, 'b')
  assert.equal(queue.dequeue()?.id, 'c')
})

test('front requeue wins ties without duplicating the same key', () => {
  const queue = createQueue()

  queue.enqueue({ id: 'a', priority: 1, valid: true, native: false })
  queue.enqueue({ id: 'b', priority: 1, valid: true, native: false })
  queue.enqueue({ id: 'retry', priority: 1, valid: true, native: false }, true)

  assert.equal(queue.enqueue({ id: 'a', priority: 0, valid: true, native: false }), false)
  assert.equal(queue.dequeue()?.id, 'retry')
})

test('dirty priorities are re-sorted lazily', () => {
  const queue = createQueue()
  const a = { id: 'a', priority: 2, valid: true, native: false }
  const b = { id: 'b', priority: 1, valid: true, native: false }

  queue.enqueue(a)
  queue.enqueue(b)

  assert.equal(queue.peek()?.id, 'b')

  a.priority = 0
  queue.markPrioritiesDirty()

  assert.equal(queue.peek()?.id, 'a')
})

test('invalid jobs are discarded and predicates select the right lane', () => {
  const queue = createQueue()

  queue.enqueue({ id: 'stale', priority: 0, valid: false, native: false })
  queue.enqueue({ id: 'local', priority: 0, valid: true, native: false })
  queue.enqueue({ id: 'native', priority: 1, valid: true, native: true })

  assert.equal(queue.dequeue(job => job.native)?.id, 'native')
  assert.equal(queue.dequeue(job => !job.native)?.id, 'local')
  assert.equal(queue.length, 0)
})
