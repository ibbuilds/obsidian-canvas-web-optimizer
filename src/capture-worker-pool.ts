type WorkerFrame = HTMLElement & {
  stop?(): void
}

type WorkerRecord = {
  frame: WorkerFrame
  document: Document
  host: HTMLElement
  inUse: boolean
}

function createHost(document: Document): HTMLElement {
  const host = document.createElement('div')

  host.classList.add('canvas-web-capture-worker-host')
  document.body.append(host)

  return host
}

export default class CaptureWorkerPool {
  private readonly records = new Set<WorkerRecord>()
  private readonly recordsByFrame = new WeakMap<HTMLElement, WorkerRecord>()
  private readonly hosts = new WeakMap<Document, HTMLElement>()

  get total(): number {
    return this.records.size
  }

  get idle(): number {
    let idle = 0

    for (const record of this.records) {
      if (!record.inUse) idle++
    }

    return idle
  }

  register(frame: WorkerFrame, document: Document) {
    const existing = this.recordsByFrame.get(frame)

    if (existing) {
      existing.inUse = true
      return
    }

    const host = this.getHost(document)
    const record: WorkerRecord = {
      frame,
      document,
      host,
      inUse: true
    }

    this.records.add(record)
    this.recordsByFrame.set(frame, record)
  }

  checkout(document: Document): WorkerFrame | null {
    for (const record of this.records) {
      if (record.document !== document || record.inUse) continue

      if (!record.frame.isConnected || !record.host.isConnected) {
        this.records.delete(record)
        this.recordsByFrame.delete(record.frame)
        record.frame.remove()
        continue
      }

      record.inUse = true
      return record.frame
    }

    return null
  }

  park(frame: WorkerFrame): boolean {
    const record = this.recordsByFrame.get(frame)

    if (!record) return false

    if (!record.host.isConnected || !record.document.body?.isConnected) {
      this.destroy(frame)
      return false
    }

    frame.stop?.()
    record.host.append(frame)
    record.inUse = false

    return true
  }

  isManaged(frame: HTMLElement | null): boolean {
    return Boolean(frame && this.recordsByFrame.has(frame))
  }

  destroy(frame: WorkerFrame) {
    const record = this.recordsByFrame.get(frame)

    if (record) {
      this.records.delete(record)
      this.recordsByFrame.delete(frame)
    }

    frame.remove()
  }

  dispose() {
    const hosts = this.getKnownHosts()

    for (const record of this.records) {
      record.frame.remove()
    }

    this.records.clear()

    for (const host of hosts) {
      host.remove()
    }
  }

  private getHost(document: Document): HTMLElement {
    const existing = this.hosts.get(document)

    if (existing?.isConnected) return existing

    const host = createHost(document)
    this.hosts.set(document, host)

    return host
  }

  private getKnownHosts(): HTMLElement[] {
    const hosts: HTMLElement[] = []

    for (const record of this.records) {
      if (!hosts.includes(record.host)) {
        hosts.push(record.host)
      }
    }

    return hosts
  }
}
