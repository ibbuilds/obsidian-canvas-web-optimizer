import { pickPreferredConcurrency } from '../core-utils'

export type ConcurrencyScore = {
  mean: number
  samples: number
}

export type ConcurrencyTuningRecord = {
  bestConcurrency: number
  scores: Record<string, ConcurrencyScore>
}

export type ConcurrencyCounters = {
  localGenerationCount: number
  localFallbacks: number
  generationPreemptions: number
}

export type ConcurrencyRenderer = {
  available: boolean
  poolSize: number
  tuningCandidates: number[]
  setPoolSize(value: number): void
}

export type TuningObservation = {
  record: ConcurrencyTuningRecord | null
  status: string
  shouldPersist: boolean
}

export default class AdaptiveConcurrencyTuner {
  status = 'hardware heuristic'

  constructor(private readonly renderer: ConcurrencyRenderer) {}

  initialize(record?: ConcurrencyTuningRecord): ConcurrencyTuningRecord | undefined {
    if (!record) {
      this.status = `hardware heuristic ${this.renderer.poolSize}`
      return undefined
    }

    const candidates = this.renderer.tuningCandidates
    const untested = candidates.find(candidate => record.scores[String(candidate)] === undefined)

    if (untested !== undefined) {
      this.renderer.setPoolSize(untested)
      const testedCount =
        candidates.length -
        candidates.filter(candidate => record.scores[String(candidate)] === undefined).length

      this.status = `calibrating ${untested} (${testedCount}/${candidates.length} tested)`
      return record
    }

    const best = pickPreferredConcurrency(candidates, record.scores, this.renderer.poolSize)

    record.bestConcurrency = best
    this.renderer.setPoolSize(best)
    this.status = `saved best ${best}`

    return record
  }

  observe(
    record: ConcurrencyTuningRecord | undefined,
    snapshot: ConcurrencyCounters & { concurrency: number },
    current: ConcurrencyCounters,
    completed: number,
    durationMs: number
  ): TuningObservation {
    if (!this.renderer.available || completed < 6 || durationMs <= 0) {
      return { record: record ?? null, status: this.status, shouldPersist: false }
    }

    const localGenerated = current.localGenerationCount - snapshot.localGenerationCount
    const fallbacks = current.localFallbacks - snapshot.localFallbacks
    const preemptions = current.generationPreemptions - snapshot.generationPreemptions

    if (localGenerated < Math.max(4, Math.floor(completed * 0.6)) || preemptions > 0) {
      this.status = 'learning skipped (mixed/preempted batch)'
      return { record: record ?? null, status: this.status, shouldPersist: false }
    }

    const throughput = completed / (durationMs / 1000)
    const fallbackRate = fallbacks / Math.max(1, localGenerated)
    const reliabilityFactor = Math.max(0.65, 1 - fallbackRate * 0.5)
    const score = throughput * reliabilityFactor
    const nextRecord = record ?? {
      bestConcurrency: snapshot.concurrency,
      scores: {}
    }

    const scoreKey = String(snapshot.concurrency)
    const existing = nextRecord.scores[scoreKey]

    nextRecord.scores[scoreKey] = existing
      ? {
          mean: (existing.mean * existing.samples + score) / (existing.samples + 1),
          samples: existing.samples + 1
        }
      : {
          mean: score,
          samples: 1
        }

    const candidates = this.renderer.tuningCandidates
    const best = pickPreferredConcurrency(candidates, nextRecord.scores, this.renderer.poolSize)

    nextRecord.bestConcurrency = best

    const untested = candidates.find(
      candidate => nextRecord.scores[String(candidate)] === undefined
    )

    if (untested !== undefined) {
      this.renderer.setPoolSize(untested)
      const testedCount =
        candidates.length -
        candidates.filter(candidate => nextRecord.scores[String(candidate)] === undefined).length

      this.status = `calibrating ${untested}; provisional best ${best} (${testedCount}/${candidates.length})`
    } else {
      const scored = candidates
        .map(concurrency => ({
          concurrency,
          score: nextRecord.scores[String(concurrency)]?.mean ?? 0,
          samples: nextRecord.scores[String(concurrency)]?.samples ?? 0
        }))
        .sort((left, right) => right.score - left.score)
      const topScore = scored[0]?.score ?? 0
      const confirmation = scored
        .filter(entry => entry.score >= topScore * 0.97 && entry.samples < 2)
        .sort((left, right) => left.concurrency - right.concurrency)[0]

      if (confirmation) {
        this.renderer.setPoolSize(confirmation.concurrency)
        this.status = `confirming ${confirmation.concurrency}; provisional best ${best}`
      } else {
        this.renderer.setPoolSize(best)
        this.status = `settled at ${best}`
      }
    }

    return { record: nextRecord, status: this.status, shouldPersist: true }
  }
}
