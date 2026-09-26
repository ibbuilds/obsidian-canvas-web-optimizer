import 'obsidian'

declare module 'obsidian' {
  interface CanvasThumbnailImage {
    getSize(): { width: number; height: number }
    isEmpty(): boolean
    resize(options: { width: number; height: number; quality: 'good' }): CanvasThumbnailImage
    toJPEG(quality: number): ArrayBuffer
  }

  interface WorkspaceLeaf {
    rebuildView(): void
  }

  interface CanvasUtilitiesEventDetail {
    reason: string
    nodeIds: string[]
  }

  interface Workspace {
    trigger(name: string): void
    on(name: string, cb: () => unknown): EventRef
    on(
      name: 'canvas-utilities:batch-start' | 'canvas-utilities:batch-end',
      cb: (canvas: Canvas, detail: CanvasUtilitiesEventDetail) => unknown
    ): EventRef
    on(
      name: 'canvas-utilities:geometry-changed',
      cb: (canvas: Canvas, detail: CanvasUtilitiesEventDetail) => unknown
    ): EventRef
  }

  interface CanvasViewportBBox {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }

  interface Canvas {
    wrapperEl: HTMLElement
    nodes?: Map<string, LinkNode>
    initialize(...args: unknown[]): unknown
    recreateFrame(...args: unknown[]): unknown
    createLinkNode(...args: unknown[]): LinkNode
    getViewportBBox?(): CanvasViewportBBox
  }

  interface CanvasLeaf extends WorkspaceLeaf {
    view: CanvasView
  }

  interface CanvasView extends View {
    canvas: Canvas
  }

  interface CanvasWebviewElement extends HTMLElement {
    capturePage(): Promise<CanvasThumbnailImage>
    executeJavaScript(code: string): Promise<unknown>
    getTitle(): string
    getWebContentsId(): number
    insertCSS(css: string): Promise<string>
    reload(): void
  }

  interface LinkNode {
    id: string
    url: string
    nodeEl: HTMLElement
    contentEl: HTMLElement & { doc: Document }
    frameEl: CanvasWebviewElement | null
    canvas?: Canvas
    x?: number
    y?: number
    width?: number
    height?: number
    isContentMounted?: boolean
    _initializing?: boolean
    _previewImageEl?: HTMLImageElement | null
    initialize(...args: unknown[]): unknown
    mountContent(...args: unknown[]): unknown
    updateBreakpoint(...args: unknown[]): unknown
    setData(...args: unknown[]): unknown
    recreateFrame(...args: unknown[]): unknown
    _getThumbnailPath(): string
    _getMetadataPath(): string
    _saveThumbnail(): Promise<boolean>
    updateNodeLabel(title: string): void
  }

  interface LinkNodeConstructor {
    prototype: LinkNode
  }

  interface Vault {
    exists(path: string): Promise<boolean>
  }

  interface CanvasNodeData {
    id: string
  }
}
