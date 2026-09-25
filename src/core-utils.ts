export type MeanScore = {
  mean: number
}

export type ScoreRecord = Record<string, MeanScore | undefined>

export function isFatalLoadFailure(event: { errorCode?: number; isMainFrame?: boolean }): boolean {
  if (event.isMainFrame === false) return false

  // ERR_ABORTED is common during normal navigation/redirects.
  return event.errorCode !== -3
}

export function calculateLivePoolSize(
  targetPoolSize: number,
  maxPoolSize: number,
  freeMemoryGiB: number,
  memoryReserveGiB: number,
  memoryPerWorkerGiB: number
): number {
  const liveMemoryLimit = Math.max(
    1,
    Math.floor(Math.max(0, freeMemoryGiB - memoryReserveGiB) / memoryPerWorkerGiB)
  )

  return Math.max(1, Math.min(Math.round(targetPoolSize), maxPoolSize, liveMemoryLimit))
}

export function buildTuningCandidates(maxPoolSize: number, heuristicPoolSize: number): number[] {
  const safeMaxPoolSize = Math.max(1, Math.round(maxPoolSize))
  const safeHeuristicPoolSize = Math.max(
    1,
    Math.min(safeMaxPoolSize, Math.round(heuristicPoolSize))
  )
  const floor = safeMaxPoolSize <= 3 ? 1 : Math.max(1, Math.floor(safeMaxPoolSize * 0.5))
  const candidates = Array.from(
    { length: safeMaxPoolSize - floor + 1 },
    (_, index) => floor + index
  )

  return candidates.sort((left, right) => {
    const leftDistance = Math.abs(left - safeHeuristicPoolSize)
    const rightDistance = Math.abs(right - safeHeuristicPoolSize)

    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }

    return right - left
  })
}

export function pickPreferredConcurrency(
  candidates: number[],
  scores: ScoreRecord,
  fallback: number,
  nearTopRatio = 0.97
): number {
  const scored = candidates
    .map(concurrency => ({
      concurrency,
      score: scores[String(concurrency)]?.mean
    }))
    .filter(
      (entry): entry is { concurrency: number; score: number } =>
        typeof entry.score === 'number' && Number.isFinite(entry.score)
    )

  if (scored.length === 0) return fallback

  const topScore = Math.max(...scored.map(entry => entry.score))
  const nearTop = scored
    .filter(entry => entry.score >= topScore * nearTopRatio)
    .sort((left, right) => left.concurrency - right.concurrency)

  return nearTop[0]?.concurrency ?? scored[0].concurrency
}

export type RectBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function createRectBounds(
  x: number | undefined,
  y: number | undefined,
  width: number | undefined,
  height: number | undefined
): RectBounds | null {
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null
  }

  return {
    minX: x,
    minY: y,
    maxX: x + width,
    maxY: y + height
  }
}

export function fitRenderSize(
  width: number,
  height: number,
  maxLongEdge: number,
  minEdge = 64
): { width: number; height: number } {
  let fittedWidth = Math.max(minEdge, width)
  let fittedHeight = Math.max(minEdge, height)
  const longEdge = Math.max(fittedWidth, fittedHeight)

  if (longEdge > maxLongEdge) {
    const scale = maxLongEdge / longEdge
    fittedWidth *= scale
    fittedHeight *= scale
  }

  return {
    width: Math.round(fittedWidth),
    height: Math.round(fittedHeight)
  }
}

export function classifyViewportProximity(node: RectBounds, viewport: RectBounds): 0 | 1 | 2 {
  const intersects = (bounds: RectBounds) =>
    node.maxX >= bounds.minX &&
    node.minX <= bounds.maxX &&
    node.maxY >= bounds.minY &&
    node.minY <= bounds.maxY

  if (intersects(viewport)) return 0

  const marginX = viewport.maxX - viewport.minX
  const marginY = viewport.maxY - viewport.minY

  if (
    intersects({
      minX: viewport.minX - marginX,
      minY: viewport.minY - marginY,
      maxX: viewport.maxX + marginX,
      maxY: viewport.maxY + marginY
    })
  ) {
    return 1
  }

  return 2
}

export function extractCanvasNodeIds(content: string): string[] {
  const canvas = JSON.parse(content) as {
    nodes?: Array<{ id?: unknown }>
  }

  return (canvas.nodes ?? [])
    .map(node => node.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}
