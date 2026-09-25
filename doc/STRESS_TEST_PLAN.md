# Scale and Lifecycle Stress Plan

This plan starts only after the architecture cleanup is green. It separates synthetic CI stress from the one runtime validation that must happen inside Obsidian.

## Automated synthetic coverage

CI exercises:

- 5,000 queued generation jobs with keyed removal, reprioritization, and full drain
- 1,000 coordinator jobs with duplicate-key rejection
- 1,000 cached Canvas nodes with a 50% cleanup pass
- existing activation, cache, tuning, diagnostics, and Canvas patch regressions

These tests validate data-structure invariants. They do not simulate Chromium/Electron rendering.

## Runtime matrix

Use the same representative URL set duplicated to reach each board size:

| Stage | Web cards | Purpose |
| --- | ---: | --- |
| A | 25 | smoke test |
| B | 50 | normal heavy board |
| C | 100 | target large board |
| D | 200 | stress |
| E | 500 | upper-bound exploratory stress |

Do not repeat every stage if an earlier stage exposes a correctness bug.

## One-pass lifecycle checks per stage

1. Open the Canvas with no cached previews and let the generation queue finish.
2. Record diagnostics after the queue reaches zero and the sidecar closes.
3. Pan and zoom across the whole board.
4. Activate several cards one at a time and confirm thumbnail -> webview -> thumbnail.
5. Open external URLs from Canvas labels.
6. Close the Canvas tab and reopen it.
7. Restart Obsidian and reopen the same Canvas.
8. Change the URL of one card and confirm only that card regenerates.
9. Duplicate a cached card and delete several cards.
10. Run **Cleanup unused thumbnails**.
11. Start generation work and close Obsidian once to validate browser cleanup.

## Correctness gates

A stage passes only if:

- no black/blank cached cards after generation or restart
- only one interactive webview stays active
- cached cards restore without bulk regeneration
- deleted nodes do not poison cache state
- changed URLs invalidate only their own cache
- the local browser closes after the queue becomes idle
- native fallback still works if the sidecar is unavailable
- selection, drag, zoom, and Canvas labels remain usable

## Resource observations

For each stage record:

- peak Obsidian RAM
- peak sidecar browser RAM
- CPU behavior while generating
- idle CPU after generation
- total batch duration
- cards/second
- fallbacks/timeouts
- local render failures
- chosen adaptive concurrency

The objective is not zero resource usage during generation. The objective is bounded generation cost and near-zero sidecar cost when idle.

## Stop conditions

Stop scaling upward if:

- the UI becomes persistently unresponsive
- final generation failures occur
- browser processes remain after idle/shutdown
- memory does not recover after generation
- cache restore starts regenerating large portions of an unchanged board

Fix the first failing scale before moving to the next one.
