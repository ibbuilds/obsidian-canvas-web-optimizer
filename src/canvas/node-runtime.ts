import type { LinkNode } from 'obsidian'
import type { CacheMetadata } from '../cache/preview-cache'
import type { FrameMode } from './link-node-patcher'

export type CanvasNodeState = {
  evaluated: boolean
  cached: boolean
  metadata: CacheMetadata | null
  preparation: Promise<void> | null
  activationHandlerAttached: boolean
}

export default class CanvasNodeRuntime {
  private readonly states = new WeakMap<LinkNode, CanvasNodeState>()
  private readonly frameModes = new WeakMap<LinkNode, FrameMode>()
  private readonly placeholders = new WeakMap<LinkNode, HTMLElement>()

  getState(node: LinkNode): CanvasNodeState {
    const existing = this.states.get(node)

    if (existing) return existing

    const state: CanvasNodeState = {
      evaluated: false,
      cached: false,
      metadata: null,
      preparation: null,
      activationHandlerAttached: false
    }

    this.states.set(node, state)
    return state
  }

  requestFrameMode(node: LinkNode, mode: FrameMode) {
    this.frameModes.set(node, mode)
  }

  consumeFrameMode(node: LinkNode): FrameMode | null {
    const mode = this.frameModes.get(node) ?? null

    if (mode) {
      this.frameModes.delete(node)
    }

    return mode
  }

  getPlaceholder(node: LinkNode): HTMLElement | undefined {
    return this.placeholders.get(node)
  }

  setPlaceholder(node: LinkNode, placeholder: HTMLElement) {
    this.placeholders.set(node, placeholder)
  }

  clearPlaceholder(node: LinkNode) {
    this.placeholders.delete(node)
  }
}
