import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import InteractiveActivationController from '../src/interactive/activation-controller'

type Node = {
  id: string
  mounted: boolean
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('interactive controller activates available nodes', async () => {
  const events: string[] = []
  const controller = new InteractiveActivationController<Node>({
    isAvailable: node => node.mounted,
    prepare: node => events.push(`prepare:${node.id}`),
    activate: node => events.push(`activate:${node.id}`),
    deactivate: async node => {
      events.push(`deactivate:${node.id}`)
      controller.clear(node)
    }
  })
  const node = { id: 'a', mounted: true }

  controller.request(node)
  await flush()

  assert.equal(controller.activeNode, node)
  assert.deepEqual(events, ['prepare:a', 'activate:a'])
})

test('interactive controller switches nodes and keeps the latest request', async () => {
  const events: string[] = []
  let releaseDeactivate: (() => void) | null = null
  const controller = new InteractiveActivationController<Node>({
    isAvailable: node => node.mounted,
    prepare: node => events.push(`prepare:${node.id}`),
    activate: node => events.push(`activate:${node.id}`),
    deactivate: node =>
      new Promise<void>(resolve => {
        events.push(`deactivate:${node.id}`)
        releaseDeactivate = () => {
          controller.clear(node)
          resolve()
        }
      })
  })
  const a = { id: 'a', mounted: true }
  const b = { id: 'b', mounted: true }
  const c = { id: 'c', mounted: true }

  controller.request(a)
  await flush()
  controller.request(b)
  await flush()
  controller.request(c)

  const release = releaseDeactivate as (() => void) | null

  assert.ok(release)
  release()
  await flush()
  await flush()

  assert.equal(controller.activeNode, c)
  assert.deepEqual(events, ['prepare:a', 'activate:a', 'deactivate:a', 'prepare:c', 'activate:c'])
})

test('interactive controller ignores unavailable and already-active nodes', async () => {
  let activations = 0
  const controller = new InteractiveActivationController<Node>({
    isAvailable: node => node.mounted,
    prepare: () => {},
    activate: () => {
      activations++
    },
    deactivate: async node => {
      controller.clear(node)
    }
  })
  const unavailable = { id: 'off', mounted: false }
  const active = { id: 'on', mounted: true }

  controller.request(unavailable)
  await flush()
  controller.request(active)
  await flush()
  controller.request(active)
  await flush()

  assert.equal(controller.activeNode, active)
  assert.equal(activations, 1)
})
