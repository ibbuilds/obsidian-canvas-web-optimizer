type Entry<T> = {
  value: T
  key: string
  order: number
  priority: number
  removed: boolean
}

export default class DynamicPriorityQueue<T> {
  private entries: Entry<T>[] = []
  private readonly byKey = new Map<string, Entry<T>>()
  private dirty = false
  private frontOrder = 0
  private backOrder = 0
  private tombstones = 0

  constructor(
    private readonly getKey: (value: T) => string,
    private readonly getPriority: (value: T) => number,
    private readonly isValid: (value: T) => boolean
  ) {}

  get length(): number {
    return this.byKey.size
  }

  has(key: string): boolean {
    return this.byKey.has(key)
  }

  clear() {
    this.entries = []
    this.byKey.clear()
    this.dirty = false
    this.frontOrder = 0
    this.backOrder = 0
    this.tombstones = 0
  }

  enqueue(value: T, front = false): boolean {
    const key = this.getKey(value)

    if (this.byKey.has(key)) return false

    const entry: Entry<T> = {
      value,
      key,
      order: front ? --this.frontOrder : ++this.backOrder,
      priority: this.getPriority(value),
      removed: false
    }

    this.entries.push(entry)
    this.byKey.set(key, entry)
    this.dirty = true

    return true
  }

  remove(key: string): T | null {
    const entry = this.byKey.get(key)

    if (!entry) return null

    this.discard(entry)
    this.compactIfNeeded()

    return entry.value
  }

  peek(predicate: (value: T) => boolean = () => true): T | null {
    this.refreshPriorities()

    for (const entry of this.entries) {
      if (entry.removed) continue

      if (!this.isValid(entry.value)) {
        this.discard(entry)
        continue
      }

      if (predicate(entry.value)) {
        this.compactIfNeeded()
        return entry.value
      }
    }

    this.compactIfNeeded()
    return null
  }

  dequeue(predicate: (value: T) => boolean = () => true): T | null {
    this.refreshPriorities()

    for (const entry of this.entries) {
      if (entry.removed) continue

      if (!this.isValid(entry.value)) {
        this.discard(entry)
        continue
      }

      if (!predicate(entry.value)) continue

      this.discard(entry)
      this.compactIfNeeded()
      return entry.value
    }

    this.compactIfNeeded()
    return null
  }

  values(): T[] {
    this.refreshPriorities()

    const values: T[] = []

    for (const entry of this.entries) {
      if (entry.removed) continue

      if (!this.isValid(entry.value)) {
        this.discard(entry)
        continue
      }

      values.push(entry.value)
    }

    this.compactIfNeeded()
    return values
  }

  markPrioritiesDirty() {
    this.dirty = true
  }

  private refreshPriorities() {
    if (!this.dirty) return

    for (const entry of this.entries) {
      if (entry.removed) continue

      if (!this.isValid(entry.value)) {
        this.discard(entry)
        continue
      }

      entry.priority = this.getPriority(entry.value)
    }

    this.compact()

    this.entries.sort((left, right) => {
      const priorityDifference = left.priority - right.priority

      if (priorityDifference !== 0) return priorityDifference

      return left.order - right.order
    })

    this.dirty = false
  }

  private discard(entry: Entry<T>) {
    if (entry.removed) return

    entry.removed = true
    this.byKey.delete(entry.key)
    this.tombstones++
  }

  private compactIfNeeded() {
    if (this.tombstones === 0) return

    if (this.tombstones >= 32 || this.tombstones > this.byKey.size) {
      this.compact()
    }
  }

  private compact() {
    if (this.tombstones === 0) return

    this.entries = this.entries.filter(entry => !entry.removed)
    this.tombstones = 0
  }
}
