import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTuningCandidates,
  calculateLivePoolSize,
  extractCanvasNodeIds,
  isFatalLoadFailure,
  pickPreferredConcurrency
} from '../src/core-utils'

test('fatal load filtering ignores subframes and ERR_ABORTED', () => {
  assert.equal(isFatalLoadFailure({ errorCode: -3, isMainFrame: true }), false)
  assert.equal(isFatalLoadFailure({ errorCode: -105, isMainFrame: false }), false)
  assert.equal(isFatalLoadFailure({ errorCode: -105, isMainFrame: true }), true)
})

test('live pool size respects target, hardware cap and free-memory cap', () => {
  assert.equal(calculateLivePoolSize(5, 8, 32, 2, 1.75), 5)
  assert.equal(calculateLivePoolSize(8, 8, 5, 2, 1.75), 1)
  assert.equal(calculateLivePoolSize(3, 2, 32, 2, 1.75), 2)
  assert.equal(calculateLivePoolSize(3, 8, 1, 2, 1.75), 1)
})

test('tuning candidates stay hardware bounded and start near the heuristic', () => {
  assert.deepEqual(buildTuningCandidates(8, 8), [8, 7, 6, 5, 4])
  assert.deepEqual(buildTuningCandidates(3, 2), [2, 3, 1])
  assert.deepEqual(buildTuningCandidates(1, 1), [1])
})

test('preferred concurrency chooses the smallest near-top performer', () => {
  const candidates = [8, 7, 6, 5, 4]
  const scores = {
    '8': { mean: 1.31 },
    '7': { mean: 1.22 },
    '6': { mean: 1.17 },
    '5': { mean: 1.31 },
    '4': { mean: 1.3 }
  }

  assert.equal(pickPreferredConcurrency(candidates, scores, 8), 4)
  assert.equal(pickPreferredConcurrency(candidates, {}, 5), 5)
})

test('Canvas cache cleanup extracts only valid string node ids', () => {
  const content = JSON.stringify({
    nodes: [{ id: 'one' }, { id: 'two' }, { id: '' }, {}, { id: 42 }]
  })

  assert.deepEqual(extractCanvasNodeIds(content), ['one', 'two'])
  assert.deepEqual(extractCanvasNodeIds('{}'), [])
})
