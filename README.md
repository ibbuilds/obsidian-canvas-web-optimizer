# Canvas Web Optimizer

A desktop-only Obsidian plugin for large, web-heavy Canvas boards.

Canvas Web Optimizer replaces idle web cards with local cached thumbnails and restores a live webview only when you interact with a card. The goal is to preserve the usefulness of Canvas web references without keeping dozens or hundreds of Chromium webviews active at the same time.

## Current behavior

- Web cards use locally cached JPEG previews when idle.
- Clicking a cached card activates its live webview.
- Only one interactive webview is kept active at a time.
- Leaving an interactive card returns it to its cached preview.
- The Canvas link label remains available on hover/selection/active cards, including at zoomed-out scales.
- Clicking the card label opens the original URL in the system browser.
- Cached previews are restored after reopening a Canvas or restarting Obsidian.
- Transparent web pages receive a white webview backdrop so they match normal browser rendering.
- Original Canvas files and URLs are never replaced by thumbnails.

## Local thumbnail renderer

On desktop, the plugin prefers an installed Chromium-based browser:

- Microsoft Edge
- Google Chrome
- Chromium
- Brave

The renderer starts only when uncached thumbnails need to be generated. It runs headless with an isolated temporary browser profile and communicates through a private Chrome DevTools Protocol pipe.

It does **not** use the user's normal browser profile, cookies, history, or signed-in sessions.

When the thumbnail queue becomes idle, the browser is closed automatically and the temporary profile is removed.

If a supported local browser is unavailable or a render fails, the plugin falls back to the native Obsidian webview generation path.

## Performance and resource controls

Thumbnail generation is designed to yield to foreground work rather than monopolize the machine.

- Concurrency is bounded by logical CPU count.
- Concurrency is bounded by installed RAM.
- Active concurrency is also clamped by currently free RAM.
- The renderer learns a good worker count for the current machine from completed batches.
- Near-equivalent throughput prefers the lower worker count.
- The sidecar browser runs below normal process priority when supported.
- User interaction preempts background thumbnail work.
- The browser is not kept alive when there is no generation work.

The fast path remains local. No screenshot API, remote rendering service, account, subscription, or bundled Chromium is required.

## Cache

Preview files live inside the plugin data directory:

```text
data/linkCache/
  <node-id>.thumbnail.jpg
  <node-id>.metadata.json
```

Cache data is disposable. Deleting it does not modify Canvas files or remove original URLs.

Use **Canvas Web Optimizer: Cleanup unused thumbnails** to remove cached files for Canvas nodes that no longer exist.

## Commands

- **Canvas Web Optimizer: Cleanup unused thumbnails**
- **Canvas Web Optimizer: Show diagnostics**
- **Canvas Web Optimizer: Reset diagnostics**

Diagnostics include queue state, cache hits/misses, local-browser lifecycle, adaptive concurrency, render timing, fallbacks, failures, and interactive webview theme state.

## Theme behavior

Thumbnail capture requests a light browser color preference so previews are consistent.

Interactive webviews also request a light color preference when the embedded page supports it. Pages with transparent backgrounds are rendered over a white webview substrate. Sites that implement their own theme logic may still control their internal colors.

## Installation

Canvas Web Optimizer is currently installed manually.

Build the plugin:

```bash
pnpm install
pnpm run build
```

Copy at least these files into:

```text
<vault>/.obsidian/plugins/canvas-web-optimizer/
```

Required files:

```text
main.js
manifest.json
styles.css
```

Reload Obsidian and enable **Canvas Web Optimizer** under **Settings → Community plugins**.

## Development

Install dependencies:

```bash
pnpm install
```

Run the regression suite:

```bash
pnpm test
```

Run formatting, lint, and TypeScript checks:

```bash
pnpm run check
```

Create a production build:

```bash
pnpm run build
```

Run the development watcher:

```bash
pnpm run dev
```

Pull requests run the regression suite, Biome checks, TypeScript validation, and a production build in CI.

## Releases

Release tags use the format `v<manifest-version>`. Pushing a matching tag runs the release workflow, rebuilds the plugin from a clean checkout, and publishes `main.js`, `manifest.json`, and `styles.css` as GitHub release assets.

Example:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## Platform notes

The plugin is desktop-only because its optimization path depends on Electron/Node capabilities.

The local-browser fast path includes browser discovery for Windows, macOS, and Linux. Runtime behavior has been exercised most heavily on Windows; machines without a supported browser automatically use the native fallback.

Sites that require an existing signed-in browser session can render differently in generated thumbnails because the sidecar intentionally uses a clean temporary profile.

## Acknowledgements

Canvas Web Optimizer is based on [Canvas Link Optimizer](https://github.com/Qbject/obsidian-canvas-link-optimizer) by Qbject.

The original project provided the foundation for cached Canvas web previews and is licensed under the MIT License.

Canvas Web Optimizer is an independent derivative project and is not affiliated with or maintained by the original author.

## License

MIT. See [LICENSE](LICENSE).
