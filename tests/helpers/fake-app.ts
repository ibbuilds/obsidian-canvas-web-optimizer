import type { App } from 'obsidian'

export type StoredValue = string | ArrayBuffer

export function createFakeApp() {
  const files = new Map<string, StoredValue>()

  const adapter = {
    async mkdir(_path: string) {},
    async exists(path: string) {
      return files.has(path)
    },
    async read(path: string) {
      const value = files.get(path)

      if (typeof value !== 'string') throw new Error(`Expected text file: ${path}`)

      return value
    },
    async write(path: string, value: string) {
      files.set(path, value)
    },
    async writeBinary(path: string, value: ArrayBuffer) {
      files.set(path, value)
    },
    async remove(path: string) {
      files.delete(path)
    },
    async list(directory: string) {
      return {
        files: [...files.keys()].filter(path => path.startsWith(`${directory}/`)),
        folders: []
      }
    },
    getResourcePath(path: string) {
      return `app://local/${path}`
    }
  }

  return {
    app: {
      vault: {
        adapter
      }
    } as unknown as App,
    files
  }
}
