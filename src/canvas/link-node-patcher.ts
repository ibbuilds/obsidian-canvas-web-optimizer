import { around } from 'monkey-around'
import type { LinkNode, LinkNodeConstructor } from 'obsidian'

export type FrameMode = 'generation' | 'preload' | 'interactive'

export type LinkNodePatchHooks = {
  saveThumbnail(node: LinkNode): Promise<boolean>
  thumbnailPath(node: LinkNode): string
  metadataPath(node: LinkNode): string
  onMounted(node: LinkNode): void
  onBreakpoint(node: LinkNode): void
  onUrlChanged(node: LinkNode): void
  onInitialized(node: LinkNode): void
  consumeFrameMode(node: LinkNode): FrameMode | null
  onFrameCreated(node: LinkNode, mode: FrameMode): void
}

export function installLinkNodePatches(
  constructor: LinkNodeConstructor,
  hooks: LinkNodePatchHooks
): () => void {
  return around(constructor.prototype, {
    _saveThumbnail: () =>
      async function (this: LinkNode) {
        return hooks.saveThumbnail(this)
      },

    _getThumbnailPath: () =>
      function (this: LinkNode) {
        return hooks.thumbnailPath(this)
      },

    _getMetadataPath: () =>
      function (this: LinkNode) {
        return hooks.metadataPath(this)
      },

    mountContent: (next: (...args: unknown[]) => unknown) =>
      function (this: LinkNode, ...args: unknown[]) {
        const result = next.call(this, ...args)

        if (!this._initializing) {
          hooks.onMounted(this)
        }

        return result
      },

    updateBreakpoint: (next: (...args: unknown[]) => unknown) =>
      function (this: LinkNode, ...args: unknown[]) {
        const result = next.call(this, ...args)

        hooks.onBreakpoint(this)

        return result
      },

    setData: (next: (...args: unknown[]) => unknown) =>
      function (this: LinkNode, ...args: unknown[]) {
        const previousUrl = this.url
        const result = next.call(this, ...args)

        if (previousUrl && previousUrl !== this.url) {
          hooks.onUrlChanged(this)
        }

        return result
      },

    initialize: (next: (...args: unknown[]) => unknown) =>
      function (this: LinkNode, ...args: unknown[]) {
        this._initializing = true

        let result: unknown

        try {
          result = next.call(this, ...args)
        } finally {
          this._initializing = false
        }

        hooks.onInitialized(this)

        return result
      },

    recreateFrame: (next: (...args: unknown[]) => unknown) =>
      function (this: LinkNode, ...args: unknown[]) {
        if (this._initializing) return null

        const mode = hooks.consumeFrameMode(this)

        if (!mode) {
          hooks.onMounted(this)
          return null
        }

        const result = next.call(this, ...args)

        hooks.onFrameCreated(this, mode)

        return result
      }
  })
}
