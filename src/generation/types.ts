import type { LinkNode } from 'obsidian'
import type { LocalBrowserRenderTask } from '../local-browser-renderer'
import type { ConcurrencyCounters } from './concurrency-tuner'

export type GenerationOutcome =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'preempted'
  | 'stale'
  | 'unmounted'

export type GenerationJob = {
  node: LinkNode
  attempt: number
  enqueuedAt: number
  forceNative: boolean
}

export type LocalConcurrentGeneration = {
  job: GenerationJob
  node: LinkNode
  url: string
  startedAt: number
  viewportWidth: number
  viewportHeight: number
  captureScale: number
  task: LocalBrowserRenderTask
  requeue: boolean
  completed: boolean
  timeoutId: number
}

export type LocalBatchTuningSnapshot = ConcurrencyCounters & {
  concurrency: number
}

export type ActiveGeneration = {
  node: LinkNode
  url: string
  startedAt: number
  viewportWidth: number
  viewportHeight: number
  frameRequestedAt?: number
  frameCreatedAt?: number
  domReadyAt?: number
  usedPreload?: boolean
  preparedByPreload?: boolean
  requeue: boolean
  finish: (outcome: GenerationOutcome) => void
}

export type GenerationPreload = {
  node: LinkNode
  startedAt: number
  frameEl: NonNullable<LinkNode['frameEl']> | null
  prepared: boolean
  readyAt?: number
  readyPromise: Promise<boolean>
  resolveReady: (ready: boolean) => void
  settled: boolean
  cleanup: () => void
}

export type DidFailLoadEvent = Event & {
  errorCode?: number
  isMainFrame?: boolean
}
