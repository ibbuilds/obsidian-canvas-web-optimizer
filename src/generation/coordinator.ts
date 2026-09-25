import DynamicPriorityQueue from './dynamic-priority-queue'

export type GenerationCoordinatorOptions<T> = {
  getKey: (value: T) => string
  getPriority: (value: T) => number
  isValid: (value: T) => boolean
  process: () => Promise<void> | void
}

export default class GenerationCoordinator<T> {
  private readonly queue: DynamicPriorityQueue<T>
  private scheduled = false

  constructor(private readonly options: GenerationCoordinatorOptions<T>) {
    this.queue = new DynamicPriorityQueue(options.getKey, options.getPriority, options.isValid)
  }

  get length(): number {
    return this.queue.length
  }

  get isScheduled(): boolean {
    return this.scheduled
  }

  has(key: string): boolean {
    return this.queue.has(key)
  }

  clear() {
    this.queue.clear()
    this.scheduled = false
  }

  enqueue(value: T, front = false): boolean {
    return this.queue.enqueue(value, front)
  }

  remove(key: string): T | null {
    return this.queue.remove(key)
  }

  peek(predicate: (value: T) => boolean = () => true): T | null {
    return this.queue.peek(predicate)
  }

  dequeue(predicate: (value: T) => boolean = () => true): T | null {
    return this.queue.dequeue(predicate)
  }

  values(): T[] {
    return this.queue.values()
  }

  markPrioritiesDirty() {
    this.queue.markPrioritiesDirty()
  }

  schedule(): boolean {
    if (this.scheduled || this.queue.length === 0) return false

    this.scheduled = true

    queueMicrotask(() => {
      this.scheduled = false
      void this.options.process()
    })

    return true
  }
}
