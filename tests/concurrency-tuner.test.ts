import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import AdaptiveConcurrencyTuner, {
  type ConcurrencyRenderer,
  type ConcurrencyTuningRecord
} from '../src/generation/concurrency-tuner'

function createRenderer(): ConcurrencyRenderer & { selected: number } {
  return {
    available: true,
    poolSize: 8,
    selected: 8,
    tuningCandidates: [8, 7, 6, 5, 4],
    setPoolSize(value: number) {
      this.selected = value
      this.poolSize = value
    }
  }
}

test('concurrency tuner starts with the first untested hardware-safe candidate', () => {
  const renderer = createRenderer()
  const tuner = new AdaptiveConcurrencyTuner(renderer)
  const record: ConcurrencyTuningRecord = {
    bestConcurrency: 8,
    scores: {
      '8': { mean: 1.3, samples: 1 }
    }
  }

  tuner.initialize(record)

  assert.equal(renderer.selected, 7)
  assert.equal(tuner.status, 'calibrating 7 (1/5 tested)')
})

test('concurrency tuner restores the best saved candidate after calibration', () => {
  const renderer = createRenderer()
  const tuner = new AdaptiveConcurrencyTuner(renderer)
  const record: ConcurrencyTuningRecord = {
    bestConcurrency: 8,
    scores: {
      '8': { mean: 1.31, samples: 2 },
      '7': { mean: 1.2, samples: 2 },
      '6': { mean: 1.15, samples: 2 },
      '5': { mean: 1.31, samples: 2 },
      '4': { mean: 1.3, samples: 2 }
    }
  }

  tuner.initialize(record)

  assert.equal(renderer.selected, 4)
  assert.equal(record.bestConcurrency, 4)
  assert.equal(tuner.status, 'saved best 4')
})

test('concurrency tuner records throughput and advances calibration', () => {
  const renderer = createRenderer()
  const tuner = new AdaptiveConcurrencyTuner(renderer)

  tuner.initialize()

  const observation = tuner.observe(
    undefined,
    {
      concurrency: 8,
      localGenerationCount: 0,
      localFallbacks: 0,
      generationPreemptions: 0
    },
    {
      localGenerationCount: 12,
      localFallbacks: 0,
      generationPreemptions: 0
    },
    12,
    9000
  )

  assert.equal(observation.shouldPersist, true)
  assert.equal(observation.record?.scores['8']?.samples, 1)
  assert.equal(renderer.selected, 7)
  assert.match(tuner.status, /^calibrating 7; provisional best 8/)
})

test('concurrency tuner skips mixed or preempted batches', () => {
  const renderer = createRenderer()
  const tuner = new AdaptiveConcurrencyTuner(renderer)

  const observation = tuner.observe(
    undefined,
    {
      concurrency: 8,
      localGenerationCount: 0,
      localFallbacks: 0,
      generationPreemptions: 0
    },
    {
      localGenerationCount: 3,
      localFallbacks: 0,
      generationPreemptions: 1
    },
    12,
    9000
  )

  assert.equal(observation.shouldPersist, false)
  assert.equal(observation.record, null)
  assert.equal(tuner.status, 'learning skipped (mixed/preempted batch)')
})
