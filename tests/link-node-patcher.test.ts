import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LinkNode, LinkNodeConstructor } from 'obsidian'
import { installLinkNodePatches, type FrameMode } from '../src/canvas/link-node-patcher'

class FakeLinkNode {
  id = 'node'
  url = 'https://before.example'
  _initializing = false
  originalMounts = 0
  originalFrames = 0

  async _saveThumbnail() {
    return false
  }

  _getThumbnailPath() {
    return 'original-thumbnail'
  }

  _getMetadataPath() {
    return 'original-metadata'
  }

  mountContent() {
    this.originalMounts++
    return 'mounted'
  }

  updateBreakpoint() {
    return 'breakpoint'
  }

  setData(url: string) {
    this.url = url
    return 'data'
  }

  initialize() {
    this.mountContent()
    return 'initialized'
  }

  recreateFrame() {
    this.originalFrames++
    return 'frame'
  }
}

test('Canvas patcher preserves initialize suppression and lifecycle hooks', async () => {
  const events: string[] = []
  const frameModes = new Map<object, FrameMode>()
  const uninstall = installLinkNodePatches(
    FakeLinkNode as unknown as LinkNodeConstructor,
    {
      saveThumbnail: async () => true,
      thumbnailPath: node => `thumb:${node.id}`,
      metadataPath: node => `meta:${node.id}`,
      onMounted: () => events.push('mounted'),
      onBreakpoint: () => events.push('breakpoint'),
      onUrlChanged: () => events.push('url-changed'),
      onInitialized: () => events.push('initialized'),
      consumeFrameMode: node => {
        const mode = frameModes.get(node) ?? null
        frameModes.delete(node)
        return mode
      },
      onFrameCreated: (_node, mode) => events.push(`frame:${mode}`)
    }
  )

  try {
    const node = new FakeLinkNode()
    const link = node as unknown as LinkNode

    assert.equal(node.initialize(), 'initialized')
    assert.equal(node.originalMounts, 1)
    assert.deepEqual(events, ['initialized'])
    assert.equal(node._initializing, false)

    assert.equal(node.mountContent(), 'mounted')
    assert.deepEqual(events, ['initialized', 'mounted'])

    assert.equal(node.updateBreakpoint(), 'breakpoint')
    assert.deepEqual(events, ['initialized', 'mounted', 'breakpoint'])

    assert.equal(node.setData('https://after.example'), 'data')
    assert.deepEqual(events, ['initialized', 'mounted', 'breakpoint', 'url-changed'])

    assert.equal(node.recreateFrame(), null)
    assert.equal(node.originalFrames, 0)
    assert.equal(events.at(-1), 'mounted')

    frameModes.set(link, 'interactive')
    assert.equal(node.recreateFrame(), 'frame')
    assert.equal(node.originalFrames, 1)
    assert.equal(events.at(-1), 'frame:interactive')

    assert.equal(await node._saveThumbnail(), true)
    assert.equal(node._getThumbnailPath(), 'thumb:node')
    assert.equal(node._getMetadataPath(), 'meta:node')
  } finally {
    uninstall()
  }
})
