export type InteractiveActivationOptions<T> = {
  isAvailable: (node: T) => boolean
  prepare: (node: T) => void
  activate: (node: T) => void
  deactivate: (node: T) => Promise<void>
}

export default class InteractiveActivationController<T> {
  private active: T | null = null
  private requested: T | null = null
  private transitionRunning = false

  constructor(private readonly options: InteractiveActivationOptions<T>) {}

  get activeNode(): T | null {
    return this.active
  }

  request(node: T) {
    this.requested = node

    if (!this.transitionRunning) {
      void this.process()
    }
  }

  clear(node: T): boolean {
    if (this.active !== node) return false

    this.active = null
    return true
  }

  cancelPending() {
    this.requested = null
  }

  clearAll() {
    this.requested = null
    this.active = null
  }

  private async process() {
    if (this.transitionRunning) return

    this.transitionRunning = true

    try {
      while (this.requested) {
        const requestedNode = this.requested
        this.requested = null

        if (!this.options.isAvailable(requestedNode) || this.active === requestedNode) {
          continue
        }

        if (this.active) {
          await this.options.deactivate(this.active)
        }

        if (this.requested) {
          continue
        }

        if (!this.options.isAvailable(requestedNode)) {
          continue
        }

        this.options.prepare(requestedNode)
        this.active = requestedNode
        this.options.activate(requestedNode)
      }
    } finally {
      this.transitionRunning = false

      if (this.requested) {
        void this.process()
      }
    }
  }
}
