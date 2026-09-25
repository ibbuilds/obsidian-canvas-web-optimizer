# Changelog

## 0.2.1

### Changed

- Split cache, diagnostics, generation scheduling, Canvas patching, interactive activation, Electron integration, and local-browser internals into focused modules without changing the stabilized Canvas workflow.
- Reworked the generation queue around keyed entries, lazy priority refresh, and tombstone compaction to reduce repeated large-array shifts on web-heavy boards.
- Prefer Canvas-coordinate viewport classification during cached-preview rehydration to avoid unnecessary DOM layout reads.
- Enabled strict TypeScript checking and aligned TypeScript/esbuild targets on ES2020.
- Upgraded development tooling to TypeScript 5.9.3, Node 22 typings, and esbuild 0.25.10.

### Added

- Architecture ownership documentation.
- Expanded regression coverage for cache lifecycle, Canvas patching, activation transitions, generation coordination, adaptive concurrency, diagnostics formatting, and large generation queues.

## 0.2.0

### Added

- Disposable local Chromium sidecar renderer using Chrome DevTools Protocol pipes.
- Automatic Edge, Chrome, Chromium, and Brave discovery on desktop platforms.
- Adaptive thumbnail concurrency based on CPU, installed RAM, free RAM, and measured throughput.
- Native Obsidian rendering fallback when the local renderer is unavailable or fails.
- Diagnostics for renderer lifecycle, throughput, failures, fallbacks, cache, and interactive webviews.
- Regression tests for load-failure handling, adaptive concurrency, tuning decisions, and Canvas cache parsing.
- Cached-preview rehydration after Canvas/workspace restore.

### Changed

- Idle Canvas web cards use cached thumbnails while live webviews are created on demand.
- Background generation yields to interactive use and runs the local browser below normal priority when supported.
- Zoomed-out Canvas link labels remain usable for relevant cards.
- Transparent interactive webviews use a white backdrop.
- Link labels open the original URL with a single click.

### Fixed

- Black/stale preview recovery paths.
- Browser lifecycle cleanup and idle shutdown.
- Thumbnail cache persistence across Obsidian restarts.
- Selection and webview activation regressions discovered during performance work.
- Theme/background mismatch for transparent pages such as frontend.supply.

## 0.1.0

Initial Canvas Web Optimizer development release.
