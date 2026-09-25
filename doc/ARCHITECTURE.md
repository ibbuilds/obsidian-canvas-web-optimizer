# Architecture

Canvas Web Optimizer is structured around a small Obsidian integration layer and isolated subsystems for cache, generation scheduling, interactive webviews, local browser rendering, diagnostics, and platform integration.

## Runtime contracts

These behaviors are compatibility contracts. Refactors must not change them unless the change is intentional and separately validated.

- Idle web cards use cached previews.
- Clicking a cached card activates its live webview.
- Only one interactive webview is active at a time.
- Deactivating a live card restores its cached preview.
- Clicking the Canvas node label opens the original URL externally.
- Canvas source files and original URLs are not rewritten.
- Cached previews survive Canvas reopen and Obsidian restart.
- Local Chromium rendering is preferred when available.
- Native Obsidian rendering remains the fallback.
- Adaptive concurrency remains bounded by CPU and memory.
- The local browser exits when generation becomes idle.
- Transparent interactive pages render over a white substrate.

## Dependency direction

```text
main.ts
├── cache/preview-cache.ts
├── canvas/node-runtime.ts
├── diagnostics/metrics.ts
├── diagnostics/report.ts
├── generation/coordinator.ts
│   └── generation/dynamic-priority-queue.ts
├── interactive/activation-controller.ts
├── interactive/webview-light.ts
│   └── platform/electron-runtime.ts
├── local-browser-renderer.ts
│   └── local-browser/renderer.ts
│       ├── local-browser/browser-discovery.ts
│       └── local-browser/cdp-connection.ts
├── background-execution.ts
├── network-preconnector.ts
├── core-utils.ts
└── web-theme.ts
```

Lower-level modules do not import the plugin class. This keeps state ownership one-directional and prevents subsystem dependency cycles.

## Main integration layer

`src/main.ts` remains responsible for Obsidian-specific composition:

- discovering and patching Canvas link nodes
- wiring Canvas lifecycle callbacks to services
- coordinating native Obsidian thumbnail generation
- connecting generation results to preview DOM state
- registering commands
- composing diagnostics

It should not accumulate storage/indexing, browser-discovery, CDP transport, queue implementation, or interaction transition state.

## Canvas node runtime

`CanvasNodeRuntime` owns ephemeral per-link-node state that must stay synchronized across Obsidian lifecycle callbacks:

- cached/evaluated state
- in-flight cache preparation
- activation-handler registration
- requested frame mode
- pending placeholder identity

The registry uses weak references so removed Canvas nodes do not become long-lived plugin state.

## Preview cache

`PreviewCache` owns cache storage invariants:

- schema initialization
- disk index construction
- thumbnail and metadata paths
- metadata memory cache
- thumbnail/metadata presence tracking
- writes and removal
- unused-cache cleanup

Cache file format remains:

```text
data/linkCache/
  <node-id>.thumbnail.jpg
  <node-id>.metadata.json
```

The Canvas document itself is not a cache backend.

## Generation scheduling

`GenerationCoordinator` owns microtask scheduling and delegates ordering/storage to `DynamicPriorityQueue`. The queue uses keyed entries plus tombstone compaction so repeated dequeues/removals do not repeatedly shift the full queue.

Priorities are dynamic:

1. visible
2. near viewport
3. background

Priority is derived from Canvas coordinates when available, avoiding per-card DOM layout reads. Queue priorities can be marked dirty when Canvas breakpoints/viewport conditions change and are re-sorted lazily.

The queue is key-addressed by node ID, which prevents duplicate work.

## Canvas Utilities coordination

Canvas Utilities is an optional producer/manipulator of native Canvas nodes. Integration is intentionally event-based rather than a package dependency.

During `canvas-utilities:batch-start`, new background generation scheduling is paused. Node initialization and cache evaluation may still occur, so work is collected without immediately consuming render resources. On `canvas-utilities:batch-end`, generation priorities are marked dirty and scheduling resumes against the final Canvas geometry. `canvas-utilities:geometry-changed` also invalidates queue priority ordering.

This boundary keeps ownership strict:

- Canvas Utilities owns node creation, size, position, grouping, alignment, and layout.
- Canvas Web Optimizer owns preview cache, thumbnail generation, webview lifecycle, and generation priority.
- Neither plugin reads or mutates the other's private storage.

## Interactive webviews

`InteractiveActivationController` owns the request/active/transition state machine. The plugin supplies side effects:

- preempt generation
- remove pending placeholders
- activate the requested frame
- deactivate the previous frame

Electron guest lookup and external URL opening live in `platform/electron-runtime.ts`.

Per-webview light preference behavior lives in `interactive/webview-light.ts`. It never changes Electron's application-wide theme.

## Local browser renderer

The public compatibility import remains `src/local-browser-renderer.ts`, which is a façade over the split implementation.

```text
local-browser/
├── browser-discovery.ts   # Edge / Chrome / Chromium / Brave discovery
├── cdp-connection.ts      # CDP pipe request/event transport
└── renderer.ts            # process lifecycle + page render/screenshot flow
```

This preserves the external `LocalBrowserRenderer` API while keeping discovery and protocol transport independently understandable.

## Diagnostics

`DiagnosticsMetrics` owns counters, timers, reset behavior, and derived averages. `diagnostics/report.ts` owns the stable human-readable report format. Runtime classes update metrics, while the plugin only collects runtime snapshots and displays the formatted report.

This prevents performance instrumentation from becoming part of control-flow state.

## Pure utilities

`core-utils.ts` contains deterministic logic suitable for unit testing:

- fatal navigation-failure classification
- memory-bounded pool size
- tuning candidate ordering
- preferred concurrency selection
- viewport proximity classification
- Canvas node-ID extraction

## Testing strategy

The regression suite protects pure state and storage boundaries before runtime/manual stress testing.

Current automated coverage includes:

- navigation failure filtering
- adaptive memory/CPU decisions
- tuning candidates and preferred concurrency
- viewport priority buckets and render-size geometry
- per-node runtime state and frame-mode consumption
- preview cache lifecycle, validation, and cleanup
- dynamic generation queue behavior, large-batch compaction, and keyed removal
- generation coordinator scheduling
- interactive activation transitions
- diagnostics report formatting

CI runs tests, Biome checks, TypeScript, and a production bundle.

## Cleanup boundary

Architecture cleanup must be separated from behavior experimentation.

Before merging a structural refactor:

1. automated regression suite must pass
2. TypeScript and Biome must pass
3. production bundle must build
4. no cache schema or interaction contract changes should be hidden inside the refactor

After structural cleanup is merged, scale/stress validation can target 25, 50, 100, 200, and 500+ web-card boards without simultaneously changing architecture.

## Future ownership boundaries

The cleanup deliberately stops before extracting DOM-heavy preview/frame orchestration. If `main.ts` grows again, the next safe extraction is native-generation orchestration. It should be moved only after enough integration coverage exists for Obsidian frame creation and preview transition behavior. Avoid moving DOM lifecycle code merely to reduce line count; subsystem invariants are more important than file size.
