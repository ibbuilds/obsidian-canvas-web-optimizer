import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LinkNode } from 'obsidian'
import CanvasNodeRuntime from '../src/canvas/node-runtime'

function node(): LinkNode {
  return {} as LinkNode
}

test('CanvasNodeRuntime creates isolated default state per node', () => {
  const runtime = new CanvasNodeRuntime()
  const first = node()
  const second = node()

  const firstState = runtime.getState(first)
  const secondState = runtime.getState(second)

  assert.deepEqual(firstState, {
    evaluated: false,
    cached: false,
    metadata: null,
    preparation: null,
    activationHandlerAttached: false
  })
  assert.notEqual(firstState, secondState)

  firstState.cached = true
  assert.equal(runtime.getState(first).cached, true)
  assert.equal(runtime.getState(second).cached, false)
})

test('CanvasNodeRuntime consumes requested frame mode exactly once', () => {
  const runtime = new CanvasNodeRuntime()
  const target = node()

  assert.equal(runtime.consumeFrameMode(target), null)

  runtime.requestFrameMode(target, 'interactive')
  assert.equal(runtime.consumeFrameMode(target), 'interactive')
  assert.equal(runtime.consumeFrameMode(target), null)
})

test('CanvasNodeRuntime owns placeholder identity without DOM operations', () => {
  const runtime = new CanvasNodeRuntime()
  const target = node()
  const placeholder = {} as HTMLElement

  runtime.setPlaceholder(target, placeholder)
  assert.equal(runtime.getPlaceholder(target), placeholder)

  runtime.clearPlaceholder(target)
  assert.equal(runtime.getPlaceholder(target), undefined)
})
