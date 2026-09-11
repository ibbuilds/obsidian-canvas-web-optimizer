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

This means a new Canvas containing many uncached web pages can still require significant resources during its initial thumbnail-generation pass.

Reducing and controlling this initial load is one of the optimization areas planned for Canvas Web Optimizer.

## Acknowledgements

Canvas Web Optimizer is based on [Canvas Link Optimizer](https://github.com/Qbject/obsidian-canvas-link-optimizer) by Qbject.

The original project provided the foundation for cached Canvas web previews and is licensed under the MIT License.

Canvas Web Optimizer is an independent derivative project and is not affiliated with or maintained by the original author.

## License

MIT. See [LICENSE](LICENSE).