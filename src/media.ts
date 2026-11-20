import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TelegramApi } from './api.js'
import type { FileBase } from './types.js'

const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

/**
 * Received files, downloaded into the bot's data directory so plugins get a `file://` URL. A Bot API file URL would
 * carry the token to every plugin and protocol client that sees the message.
 */
export class MediaStore {
  /** file_unique_id → file name, what is on disk */
  private known?: Map<string, string>
  private pending = new Map<string, Promise<string | undefined>>()

  constructor(
    private readonly api: TelegramApi,
    private readonly directory: () => Promise<string>,
    private readonly maxSize: number,
    private readonly warn: (message: string) => void,
  ) {}

  private async dir() {
    const dir = path.join(await this.directory(), 'media')
    if (!this.known) {
      await mkdir(dir, { recursive: true })
      this.known = new Map()
      for (const name of await readdir(dir)) this.known.set(stem(name), name)
    }
    return dir
  }

  /** The file's URL, or undefined when it is too big or cannot be downloaded */
  async url(file: FileBase): Promise<string | undefined> {
    if (file.file_size !== undefined && file.file_size > this.maxSize * MB) return
    let task = this.pending.get(file.file_unique_id)
    if (!task) {
      task = this.download(file).finally(() => this.pending.delete(file.file_unique_id))
      this.pending.set(file.file_unique_id, task)
    }
    return task
  }

  private async download(file: FileBase): Promise<string | undefined> {
    const dir = await this.dir()
    const cached = this.known!.get(file.file_unique_id)
    if (cached) return pathToFileURL(path.join(dir, cached)).href
    try {
      const data = await this.api.download(file.file_id)
      if (data.data.byteLength > this.maxSize * MB) return
      // Only the extension of Telegram's path: the unique id is the name, safe for any file system
      const ext = path.extname(data.path).replace(/[^.\w]/g, '') || extOf(file.file_name)
      const name = file.file_unique_id.replace(/[^\w-]/g, '_') + ext
      await writeFile(path.join(dir, name), Buffer.from(data.data))
      this.known!.set(file.file_unique_id, name)
      return pathToFileURL(path.join(dir, name)).href
    } catch (e) {
      this.warn(`下载文件 ${file.file_name ?? file.file_unique_id} 失败: ${(e as Error).message}`)
    }
  }

  /** Removes what was downloaded more than `days` ago */
  async cleanup(days: number) {
    const dir = await this.dir()
    const before = Date.now() - days * DAY
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name)
      const info = await stat(full).catch(() => undefined)
      if (!info?.isFile() || info.mtimeMs >= before) continue
      await rm(full, { force: true })
      this.known!.delete(stem(name))
    }
  }
}

function stem(name: string) {
  const ext = path.extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

function extOf(name?: string) {
  return name ? path.extname(name).replace(/[^.\w]/g, '') : ''
}
