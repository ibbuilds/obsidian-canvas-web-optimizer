# Canvas Web Optimizer

A performance-focused Obsidian plugin for web-heavy Canvas boards.

Canvas Web Optimizer reduces the cost of embedded web pages by displaying cached previews instead of keeping every website loaded at the same time.

The project is designed for large research boards, inspiration boards, moodboards, and other Obsidian Canvas workflows containing many web references.

## Why?

A Canvas containing many live web pages can become expensive very quickly.

Every active page can consume resources through:

- JavaScript execution
- animations
- timers
- network requests
- media
- DOM rendering
- Chromium webview processes

For a board containing dozens or hundreds of websites, this can result in high CPU and RAM usage and noticeably worse Canvas performance.

Canvas Web Optimizer aims to keep the visual usefulness of web cards without keeping every website active unnecessarily.

## Current behavior

Web page cards can be represented using locally cached thumbnails instead of automatically keeping the full webpage loaded.

When the full webpage is needed, the card can be activated again.

Cached previews are stored locally in the plugin's data directory and do not modify the Canvas file itself.

If the cache is deleted, the original Canvas URLs remain intact and previews can be regenerated.

## Local thumbnail renderer

On desktop, Canvas Web Optimizer can use an installed Chromium-based browser such as Microsoft Edge, Google Chrome, Chromium, or Brave to generate preview screenshots outside Obsidian's Canvas renderer.

The local renderer is designed to be automatic:

- It starts only when uncached previews need to be generated.
- It runs headless, without opening a visible browser window.
- It uses a temporary isolated browser profile in the operating system's temporary directory.
- It does not use or modify the user's normal browser profile, cookies, history, or signed-in sessions.
- It closes automatically after the thumbnail queue becomes idle.
- Its temporary profile is removed after shutdown.
- If no supported local browser is available or rendering fails, the plugin falls back to the native Obsidian generation pipeline.

This feature launches a browser executable installed outside the vault and loads the same URLs that are present in the Canvas. Thumbnail generation remains local: no third-party screenshot service, paid API, telemetry service, or remote thumbnail backend is used.

The cached JPEG previews and metadata remain inside the plugin data directory and the original Canvas files are not modified.

## Goals

Canvas Web Optimizer is being developed around a few principles:

- Keep large web-heavy canvases responsive
- Avoid unnecessary live webviews
- Cache lightweight visual previews locally
- Keep Canvas files and user content untouched
- Preserve original URLs
- Minimize idle CPU, RAM, and network usage
- Make web pages available quickly when the user actually needs them

Planned performance improvements include:

- Limit the number of simultaneously active webviews
- Automatically return inactive web pages to cached previews
- Optional instant hover activation
- Controlled thumbnail-generation concurrency
- Smarter cache management
- Further optimizations for very large canvases

## Cache

Preview thumbnails are disposable cache data.

They are stored inside the plugin's local data directory rather than as Canvas attachments.

Deleting the cache does not delete or modify the original links in your Canvas.

## Installation

Canvas Web Optimizer is currently under development and is not yet available through the Obsidian Community Plugins directory.

### Manual installation

Build the plugin:

```bash
pnpm install
pnpm run build
```

Then copy the required plugin files into:

```text
<vault>/.obsidian/plugins/canvas-web-optimizer/
```

At minimum:

```text
main.js
manifest.json
styles.css
```

Then reload Obsidian and enable **Canvas Web Optimizer** under:

**Settings → Community plugins**

## Development

Install dependencies:

```bash
pnpm install
```

Create a production build:

```bash
pnpm run build
```

Run the development build:

```bash
pnpm run dev
```

## Important

Generating a thumbnail requires the webpage to load at least once.

The local renderer can process several pages concurrently, but initial generation still uses CPU, memory, network bandwidth, and the installed browser. The plugin limits concurrency and shuts the browser down when the queue is idle rather than leaving a background browser running permanently.

Sites that require an existing logged-in browser session may render differently because the thumbnail renderer intentionally uses an isolated temporary profile.

## Acknowledgements

Canvas Web Optimizer is based on [Canvas Link Optimizer](https://github.com/Qbject/obsidian-canvas-link-optimizer) by Qbject.

The original project provided the foundation for cached Canvas web previews and is licensed under the MIT License.

Canvas Web Optimizer is an independent derivative project and is not affiliated with or maintained by the original author.

## License

MIT. See [LICENSE](LICENSE).