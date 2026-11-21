import type { Http, HttpFile } from '@luckylillia-dev/plugin-sdk'
import type { File } from './types.js'

/** What the Bot API answered with `ok: false` */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} 失败 (${code}): ${description}`)
    this.name = 'TelegramError'
  }
}

export interface ApiOptions {
  token: string
  /** Without the trailing slash, e.g. https://api.telegram.org */
  endpoint: string
}

/** 429 answers up to this many seconds away are waited out and retried */
const MAX_RETRY_AFTER = 30

/**
 * The Bot API over `ctx.http`, so the「代理」entry's proxy applies. The token is part of every URL: it never goes
 * into an error message or a log line.
 */
export class TelegramApi {
  private readonly base: string
  private readonly fileBase: string

  constructor(private readonly http: Http, private readonly options: ApiOptions) {
    const endpoint = options.endpoint.replace(/\/+$/, '')
    this.base = `${endpoint}/bot${options.token}/`
    this.fileBase = `${endpoint}/file/bot${options.token}/`
  }

  /** Calls `method` with a JSON body, or multipart when there are files in `data` (a FormData). */
  async call<T = any>(method: string, data?: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, data, signal)
      } catch (e) {
        if (e instanceof TelegramError && e.code === 429 && e.retryAfter !== undefined
          && e.retryAfter <= MAX_RETRY_AFTER && attempt < 3 && !signal?.aborted) {
          await sleep(e.retryAfter * 1000, signal)
          continue
        }
        throw e
      }
    }
  }

  private async once<T>(method: string, data: Record<string, unknown> | FormData | undefined, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { method: 'POST', signal }
    if (data instanceof FormData) {
      init.body = data
    } else {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(withoutUndefined(data ?? {}))
    }
    let response: Response
    try {
      response = await this.http.fetch(this.base + method, init)
    } catch (e) {
      throw this.redact(e)
    }
    let body: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
    try {
      body = await response.json()
    } catch {
      throw new TelegramError(method, response.status, response.statusText || '返回的不是 JSON')
    }
    if (body.ok) return body.result as T
    throw new TelegramError(method, body.error_code ?? response.status, body.description ?? '未知错误', body.parameters?.retry_after)
  }

  /** Downloads a file the Bot API has; bots may only download files up to 20 MB. */
  async download(fileId: string, signal?: AbortSignal): Promise<HttpFile & { path: string }> {
    const file = await this.call<File>('getFile', { file_id: fileId }, signal)
    if (!file.file_path) throw new TelegramError('getFile', 400, '文件不可下载')
    try {
      const data = await this.http.file(this.fileBase + file.file_path, { signal })
      return { ...data, path: file.file_path }
    } catch (e) {
      throw this.redact(e)
    }
  }

  /** The same error with the token blanked out of its message (fetch errors name the URL) */
  private redact(e: unknown): unknown {
    if (!(e instanceof Error)) return e
    const { token } = this.options
    if (e.message.includes(token)) e.message = e.message.split(token).join('<token>')
    return e
  }
}

function withoutUndefined(data: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const key in data) if (data[key] !== undefined) result[key] = data[key]
  return result
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}
