type Entry<T> = {
  value: T
  key: string
  order: number
}

export default class DynamicPriorityQueue<T> {
  private entries: Entry<T>[] = []
  private readonly keys = new Set<string>()
  private dirty = false
  private frontOrder = 0
  private backOrder = 0

  constructor(
    private readonly getKey: (value: T) => string,
    private readonly getPriority: (value: T) => number,
    private readonly isValid: (value: T) => boolean
  ) {}

  get length(): number {
    return this.entries.length
  }

  has(key: string): boolean {
    return this.keys.has(key)
  }

  clear() {
    this.entries = []
    this.keys.clear()
    this.dirty = false
    this.frontOrder = 0
    this.backOrder = 0
  }

  enqueue(value: T, front = false): boolean {
    const key = this.getKey(value)

    if (this.keys.has(key)) return false

    const order = front ? --this.frontOrder : ++this.backOrder

    this.entries.push({ value, key, order })
    this.keys.add(key)
    this.dirty = true

    return true
  }

  remove(key: string): T | null {
    const index = this.entries.findIndex(entry => entry.key === key)

    if (index < 0) return null

    const [entry] = this.entries.splice(index, 1)
    this.keys.delete(key)

    return entry.value
  }

  peek(predicate: (value: T) => boolean = () => true): T | null {
    this.refresh()

    return this.entries.find(entry => predicate(entry.value))?.value ?? null
  }

  dequeue(predicate: (value: T) => boolean = () => true): T | null {
    this.refresh()

    const index = this.entries.findIndex(entry => predicate(entry.value))

    if (index < 0) return null

    const [entry] = this.entries.splice(index, 1)
    this.keys.delete(entry.key)

    return entry.value
  }

  values(): T[] {
    this.refresh()

    return this.entries.map(entry => entry.value)
  }

  markPrioritiesDirty() {
    this.dirty = true
  }

  private refresh() {
    let removedInvalid = false

    this.entries = this.entries.filter(entry => {
      if (this.isValid(entry.value)) return true

      this.keys.delete(entry.key)
      removedInvalid = true
      return false
    })

    if (!this.dirty && !removedInvalid) return

    this.entries.sort((left, right) => {
      const priorityDifference = this.getPriority(left.value) - this.getPriority(right.value)

      if (priorityDifference !== 0) return priorityDifference

      return left.order - right.order
    })

    this.dirty = false
  }
}
