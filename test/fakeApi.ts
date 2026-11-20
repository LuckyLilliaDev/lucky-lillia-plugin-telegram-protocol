import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
export const BOT_ID = 123456789

export interface ApiCall {
  method: string
  /** The JSON body, or the multipart fields with files as { name, size, type } */
  body: Record<string, any>
}

/**
 * A Bot API on a local port: records the calls, answers them from `handlers`, and serves `push`ed updates to
 * getUpdates.
 */
export class FakeApi {
  calls: ApiCall[] = []
  handlers: Record<string, (body: Record<string, any>) => unknown> = {}
  files: Record<string, Buffer> = {}
  private updates: any[] = []
  private nextUpdate = 1
  private nextMessage = 1000
  private waiting?: () => void
  private server!: Server
  endpoint = ''

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks)
      const url = new URL(req.url!, 'http://localhost')
      const filePrefix = `/file/bot${TOKEN}/`
      if (url.pathname.startsWith(filePrefix)) {
        const data = this.files[url.pathname.slice(filePrefix.length)]
        res.writeHead(data ? 200 : 404, { 'content-type': 'application/octet-stream' })
        return res.end(data)
      }
      const prefix = `/bot${TOKEN}/`
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
      }
      const method = url.pathname.slice(prefix.length)
      const body = await parseBody(raw, String(req.headers['content-type'] ?? ''))
      if (method !== 'getUpdates') this.calls.push({ method, body })
      let result: unknown
      try {
        result = await this.answer(method, body)
      } catch (e) {
        const { code, description } = e as { code: number; description: string }
        res.writeHead(code, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error_code: code, description }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result }))
    })
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop() {
    this.waiting?.()
    this.server.closeAllConnections()
    await new Promise(resolve => this.server.close(resolve))
  }

  push(update: Record<string, unknown>) {
    this.updates.push({ update_id: this.nextUpdate++, ...update })
    this.waiting?.()
  }

  /** Waits for a call of `method` after the ones already seen */
  async waitFor(method: string, count = 1, timeout = 3000): Promise<ApiCall[]> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const found = this.calls.filter(c => c.method === method)
      if (found.length >= count) return found
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`no ${count} call(s) of ${method}; got ${this.calls.map(c => c.method).join(', ')}`)
  }

  private async answer(method: string, body: Record<string, any>) {
    const handler = this.handlers[method]
    if (handler) return handler(body)
    switch (method) {
      case 'getMe':
        return { id: BOT_ID, is_bot: true, first_name: 'Lillia', username: 'LilliaBot' }
      case 'getWebhookInfo':
        return { url: '', pending_update_count: 0 }
      case 'getUpdates': {
        if (body.offset === -1) return []
        const offset = Number(body.offset ?? 0)
        let pending = this.updates.filter(u => u.update_id >= offset)
        if (!pending.length) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 200)
            this.waiting = () => { clearTimeout(timer); resolve() }
          })
          this.waiting = undefined
          pending = this.updates.filter(u => u.update_id >= offset)
        }
        return pending
      }
      case 'sendMessage': case 'sendPhoto': case 'sendDocument': case 'sendVideo': case 'sendAudio':
      case 'sendVoice': case 'sendAnimation': case 'sendSticker':
        return this.sent(body)
      case 'sendMediaGroup':
        return JSON.parse(body.media).map(() => this.sent(body))
      default:
        return true
    }
  }

  private sent(body: Record<string, any>) {
    const chatId = Number(body.chat_id)
    return {
      message_id: this.nextMessage++,
      date: Math.floor(Date.now() / 1000),
      chat: chatId > 0 ? { id: chatId, type: 'private', first_name: 'U' } : { id: chatId, type: 'supergroup', title: 'G' },
      from: { id: BOT_ID, is_bot: true, first_name: 'Lillia', username: 'LilliaBot' },
      text: body.text,
      caption: body.caption,
    }
  }
}

async function parseBody(raw: Buffer, type: string): Promise<Record<string, any>> {
  if (!raw.length) return {}
  if (type.includes('application/json')) return JSON.parse(raw.toString())
  if (type.includes('multipart/form-data')) {
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData()
    const result: Record<string, any> = {}
    for (const [key, value] of form) {
      result[key] = typeof value === 'string' ? value : { name: value.name, size: value.size, type: value.type }
    }
    return result
  }
  return {}
}
