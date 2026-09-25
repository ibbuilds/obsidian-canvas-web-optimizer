import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import GenerationCoordinator from '../src/generation/coordinator'

type Job = {
  id: string
  priority: number
  valid: boolean
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('generation coordinator schedules one microtask at a time', async () => {
  let runs = 0
  const coordinator = new GenerationCoordinator<Job>({
    getKey: job => job.id,
    getPriority: job => job.priority,
    isValid: job => job.valid,
    process: () => {
      runs++
    }
  })

  coordinator.enqueue({ id: 'a', priority: 0, valid: true })

  assert.equal(coordinator.schedule(), true)
  assert.equal(coordinator.schedule(), false)
  assert.equal(coordinator.isScheduled, true)

  await flush()

  assert.equal(runs, 1)
  assert.equal(coordinator.isScheduled, false)
})

test('generation coordinator exposes priority queue operations', () => {
  const coordinator = new GenerationCoordinator<Job>({
    getKey: job => job.id,
    getPriority: job => job.priority,
    isValid: job => job.valid,
    process: () => {}
  })

  coordinator.enqueue({ id: 'background', priority: 2, valid: true })
  coordinator.enqueue({ id: 'visible', priority: 0, valid: true })

  assert.equal(coordinator.peek()?.id, 'visible')
  assert.equal(coordinator.dequeue()?.id, 'visible')
  assert.equal(coordinator.has('background'), true)
  assert.equal(coordinator.remove('background')?.id, 'background')
  assert.equal(coordinator.length, 0)
})
