import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTuningCandidates,
  calculateLivePoolSize,
  classifyViewportProximity,
  createRectBounds,
  extractCanvasNodeIds,
  fitRenderSize,
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

test('viewport proximity classifies visible, nearby, and background nodes', () => {
  const viewport = { minX: 0, minY: 0, maxX: 100, maxY: 100 }

  assert.equal(classifyViewportProximity({ minX: 10, minY: 10, maxX: 20, maxY: 20 }, viewport), 0)
  assert.equal(classifyViewportProximity({ minX: 150, minY: 20, maxX: 170, maxY: 40 }, viewport), 1)
  assert.equal(classifyViewportProximity({ minX: 350, minY: 20, maxX: 370, maxY: 40 }, viewport), 2)
})

test('node geometry converts Canvas coordinates to bounds', () => {
  assert.deepEqual(createRectBounds(10, 20, 300, 200), {
    minX: 10,
    minY: 20,
    maxX: 310,
    maxY: 220
  })
  assert.equal(createRectBounds(undefined, 20, 300, 200), null)
})

test('thumbnail render size clamps small cards and scales oversized cards', () => {
  assert.deepEqual(fitRenderSize(40, 20, 896), { width: 64, height: 64 })
  assert.deepEqual(fitRenderSize(640, 360, 896), { width: 640, height: 360 })
  assert.deepEqual(fitRenderSize(1792, 896, 896), { width: 896, height: 448 })
})

test('Canvas cache cleanup extracts only valid string node ids', () => {
  const content = JSON.stringify({
    nodes: [{ id: 'one' }, { id: 'two' }, { id: '' }, {}, { id: 42 }]
  })

  assert.deepEqual(extractCanvasNodeIds(content), ['one', 'two'])
  assert.deepEqual(extractCanvasNodeIds('{}'), [])
})
