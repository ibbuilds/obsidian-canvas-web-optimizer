const CDP_COMMAND_TIMEOUT_MS = 3500

type CdpResponseError = {
  code?: number
  message?: string
}

type CdpMessage = {
  id?: number
  method?: string
  sessionId?: string
  result?: unknown
  error?: CdpResponseError
  params?: unknown
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeoutId: number
}

type EventWaiter = {
  method: string
  sessionId?: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeoutId: number
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export default class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly eventWaiters = new Set<EventWaiter>()
  private incomingBuffer = ''
  private closed = false

  constructor(
    private readonly outgoing: NodeJS.WritableStream,
    private readonly incoming: NodeJS.ReadableStream
  ) {
    incoming.on('data', this.onData)
    incoming.on('end', this.onClosed)
    incoming.on('close', this.onClosed)
    incoming.on('error', this.onClosed)
    outgoing.on('error', this.onClosed)
  }

  get isOpen(): boolean {
    return !this.closed
  }

  send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS
  ): Promise<T> {
    if (!this.isOpen) {
      return Promise.reject(new Error('Local browser DevTools pipe is not open'))
    }

    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeoutId
      })

      const message: {
        id: number
        method: string
        params: Record<string, unknown>
        sessionId?: string
      } = {
        id,
        method,
        params
      }

      if (sessionId) {
        message.sessionId = sessionId
      }

      try {
        this.outgoing.write(`${JSON.stringify(message)}\x00`)
      } catch (error) {
        this.pending.delete(id)
        window.clearTimeout(timeoutId)
        reject(toError(error))
      }
    })
  }

  waitForEvent<T>(
    method: string,
    sessionId?: string,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS
  ): Promise<T> {
    if (!this.isOpen) {
      return Promise.reject(new Error('Local browser DevTools pipe is not open'))
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: EventWaiter = {
        method,
        sessionId,
        resolve: value => resolve(value as T),
        reject,
        timeoutId: 0
      }

      waiter.timeoutId = window.setTimeout(() => {
        this.eventWaiters.delete(waiter)
        reject(new Error(`CDP event timed out: ${method}`))
      }, timeoutMs)

      this.eventWaiters.add(waiter)
    })
  }

  close() {
    if (this.closed) return

    this.closed = true
    this.detach()
    this.rejectAll(new Error('Local browser DevTools pipe closed'))
  }

  private readonly onData = (chunk: unknown) => {
    if (this.closed) return

    this.incomingBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)

    let separatorIndex = this.incomingBuffer.indexOf('\x00')

    while (separatorIndex >= 0) {
      const rawMessage = this.incomingBuffer.slice(0, separatorIndex)
      this.incomingBuffer = this.incomingBuffer.slice(separatorIndex + 1)

      if (rawMessage) {
        this.handleMessage(rawMessage)
      }

      separatorIndex = this.incomingBuffer.indexOf('\x00')
    }

    if (this.incomingBuffer.length > 4_000_000) {
      this.close()
    }
  }

  private readonly onClosed = () => {
    if (this.closed) return

    this.closed = true
    this.detach()
    this.rejectAll(new Error('Local browser DevTools pipe closed'))
  }

  private handleMessage(rawMessage: string) {
    let message: CdpMessage

    try {
      message = JSON.parse(rawMessage) as CdpMessage
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)

      if (!pending) return

      this.pending.delete(message.id)
      window.clearTimeout(pending.timeoutId)

      if (message.error) {
        pending.reject(
          new Error(
            `CDP command failed (${message.error.code ?? 'unknown'}): ${
              message.error.message ?? 'unknown error'
            }`
          )
        )
      } else {
        pending.resolve(message.result)
      }

      return
    }

    if (!message.method) return

    for (const waiter of [...this.eventWaiters]) {
      if (waiter.method !== message.method) continue
      if (waiter.sessionId !== undefined && waiter.sessionId !== message.sessionId) continue

      this.eventWaiters.delete(waiter)
      window.clearTimeout(waiter.timeoutId)
      waiter.resolve(message.params)
    }
  }

  private detach() {
    this.incoming.removeListener('data', this.onData)
    this.incoming.removeListener('end', this.onClosed)
    this.incoming.removeListener('close', this.onClosed)
    this.incoming.removeListener('error', this.onClosed)
    this.outgoing.removeListener('error', this.onClosed)
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId)
      pending.reject(error)
    }

    this.pending.clear()

    for (const waiter of this.eventWaiters) {
      window.clearTimeout(waiter.timeoutId)
      waiter.reject(error)
    }

    this.eventWaiters.clear()
  }
}
