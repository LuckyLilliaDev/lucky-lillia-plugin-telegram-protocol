import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { h } from '@luckylillia/plugin-sdk'
import type { Http, NeutralResource } from '@luckylillia/plugin-sdk'
import { TelegramApi, TelegramError } from './api.js'
import type { CommandButtons } from './buttons.js'
import { decodeMessage, type DecodeContext } from './decode.js'
import { parseChannel } from './ids.js'
import type { InlineKeyboardButton, Message } from './types.js'

/** What the encoder needs of the bot */
export interface EncoderHost {
  api: TelegramApi
  http: Http
  buttons: CommandButtons
  decodeContext: DecodeContext
  warn(message: string): void
}

const TEXT_LIMIT = 4096
const CAPTION_LIMIT = 1024
const ALBUM_LIMIT = 10
/** TG will not send a message without text; this one shows as nothing */
const INVISIBLE = '⁣'

/** What the Bot API sends a file as; the decoder puts the received one's in `telegramType` */
export type MediaKind = 'photo' | 'animation' | 'video' | 'video_note' | 'audio' | 'voice' | 'document' | 'sticker'

interface Media {
  kind: MediaKind
  element: h
}

const METHODS: Record<MediaKind, string> = {
  photo: 'sendPhoto',
  animation: 'sendAnimation',
  video: 'sendVideo',
  video_note: 'sendVideoNote',
  audio: 'sendAudio',
  voice: 'sendVoice',
  document: 'sendDocument',
  sticker: 'sendSticker',
}

/** Received from Telegram: sent again as what it was */
function receivedKind(element: h): MediaKind | undefined {
  const kind = element.attrs.telegramType
  return typeof kind === 'string' && kind in METHODS ? kind as MediaKind : undefined
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The plain text of elements, e.g. a button's label */
export function plainText(elements: h[]): string {
  return elements.map(e => e.type === 'text' ? String(e.attrs.content ?? '') : plainText(e.children)).join('')
}

/**
 * Turns Satori elements into Bot API calls for one channel. Text and formatting go as Telegram HTML; a message
 * holds one file with its text as the caption, several photos and videos go as an album; buttons go on the last
 * message of the batch.
 */
export class MessageEncoder {
  private html = ''
  private media: Media[] = []
  private rows: InlineKeyboardButton[][] = []
  private replyTo?: number
  private readonly results: NeutralResource[] = []
  private readonly target

  constructor(private readonly host: EncoderHost, private readonly channelId: string) {
    this.target = parseChannel(channelId)
  }

  async send(elements: h[]): Promise<NeutralResource[]> {
    await this.render(elements)
    await this.flush()
    return this.results
  }

  private async render(elements: h[]) {
    for (const element of elements) await this.visit(element)
  }

  private async wrap(open: string, close: string, children: h[]) {
    this.html += open
    await this.render(children)
    this.html += close
  }

  private async visit(element: h) {
    const { type, attrs, children } = element
    switch (type) {
      case 'text':
        this.html += escapeHtml(String(attrs.content ?? ''))
        return
      case 'br':
        this.html += '\n'
        return
      case 'p':
        if (this.html && !this.html.endsWith('\n')) this.html += '\n'
        await this.render(children)
        this.html += '\n'
        return
      case 'b': case 'strong':
        return this.wrap('<b>', '</b>', children)
      case 'i': case 'em':
        return this.wrap('<i>', '</i>', children)
      case 'u': case 'ins':
        return this.wrap('<u>', '</u>', children)
      case 's': case 'del':
        return this.wrap('<s>', '</s>', children)
      case 'spl':
        return this.wrap('<tg-spoiler>', '</tg-spoiler>', children)
      case 'code':
        if (attrs.content !== undefined) this.html += `<code>${escapeHtml(String(attrs.content))}</code>`
        else await this.wrap('<code>', '</code>', children)
        return
      case 'pre':
        return this.wrap('<pre>', '</pre>', children)
      case 'a': {
        const href = String(attrs.href ?? '')
        if (!href) return this.render(children)
        this.html += `<a href="${escapeHtml(href)}">`
        if (children.length) await this.render(children)
        else this.html += escapeHtml(href)
        this.html += '</a>'
        return
      }
      case 'at': {
        if (attrs.type === 'all' || attrs.type === 'here') {
          this.html += '@all'
        } else if (attrs.id && /^\d+$/.test(String(attrs.id))) {
          this.html += `<a href="tg://user?id=${attrs.id}">@${escapeHtml(String(attrs.name || attrs.id))}</a>`
        } else if (attrs.name || attrs.id) {
          this.html += '@' + escapeHtml(String(attrs.name || attrs.id))
        }
        return
      }
      case 'sharp':
        this.html += '#' + escapeHtml(String(attrs.name || attrs.id || ''))
        return
      case 'quote':
        if (attrs.id !== undefined) {
          const id = Number(attrs.id)
          if (Number.isSafeInteger(id)) this.replyTo = id
          return
        }
        return this.wrap('<blockquote>', '</blockquote>', children)
      case 'img': case 'image':
        this.media.push({ kind: receivedKind(element) ?? (isGif(attrs) ? 'animation' : 'photo'), element })
        return
      case 'video':
        this.media.push({ kind: receivedKind(element) ?? 'video', element })
        return
      case 'audio':
        this.media.push({ kind: receivedKind(element) ?? audioKind(attrs), element })
        return
      case 'file':
        this.media.push({ kind: receivedKind(element) ?? 'document', element })
        return
      case 'button':
        this.button(attrs, plainText(children))
        return
      case 'button-group':
        this.rows.push([])
        await this.render(children)
        this.rows.push([])
        return
      case 'message':
        // Each message of a forward, or a message of its own in the batch
        await this.flush()
        await this.render(children)
        await this.flush()
        return
      case 'author':
        return
      default:
        // Other platforms' elements: what is inside them
        return this.render(children)
    }
  }

  private button(attrs: Record<string, any>, label: string) {
    let button: InlineKeyboardButton | undefined
    if (attrs.type === 'link') {
      if (attrs.href) button = { text: label || attrs.href, url: String(attrs.href) }
    } else if (attrs.type === 'action') {
      const id = String(attrs.id ?? '')
      if (id && Buffer.byteLength(id) <= 64) button = { text: label || id, callback_data: id }
      else this.host.warn(`按钮 ${label} 的 id 为空或超过 64 字节，已丢弃`)
    } else {
      const text = String(attrs.text ?? label)
      if (text) button = { text: label || text, callback_data: this.host.buttons.encode(text) }
    }
    if (!button) return
    if (!this.rows.length) this.rows.push([])
    let row = this.rows[this.rows.length - 1]
    if (row.length >= 8) this.rows.push(row = [])
    row.push(button)
  }

  private takeMarkup() {
    const rows = this.rows.filter(row => row.length)
    this.rows = []
    return rows.length ? { inline_keyboard: rows } : undefined
  }

  /** Sends what has been collected */
  private async flush() {
    const html = this.html.trim()
    const media = this.media
    let markup = this.takeMarkup()
    this.html = ''
    this.media = []
    if (!html && !media.length && !markup) return

    if (!media.length) {
      const chunks = splitText(html || INVISIBLE)
      for (let i = 0; i < chunks.length; i++) {
        await this.sendText(chunks[i], i === chunks.length - 1 ? markup : undefined)
      }
      return
    }

    // The text goes as the caption of the first file that takes one, when it is short enough
    let caption = html.length <= CAPTION_LIMIT ? html : ''
    const all = batches(media)
    if (caption && !all.some(captionable)) caption = ''
    const rest = caption ? '' : html
    // Albums take no buttons: those go with the text after them, or on a message of their own
    for (const batch of all) {
      const text = captionable(batch) ? caption : ''
      if (text) caption = ''
      if (batch.length === 1) {
        const finalOne = batch === all[all.length - 1] && !rest
        await this.sendMedia(batch[0], text, finalOne ? markup : undefined)
        if (finalOne) markup = undefined
      } else {
        await this.sendAlbum(batch, text)
      }
    }
    if (rest || markup) {
      const chunks = splitText(rest || INVISIBLE)
      for (let i = 0; i < chunks.length; i++) {
        await this.sendText(chunks[i], i === chunks.length - 1 ? markup : undefined)
      }
    }
  }

  /** Fields of every send: where, and what it replies to (the first message of the batch only) */
  private common() {
    const replyTo = this.replyTo
    this.replyTo = undefined
    return {
      chat_id: this.target.chat_id,
      message_thread_id: this.target.message_thread_id,
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    }
  }

  private async sendText(text: string, markup?: object) {
    const message = await this.host.api.call<Message>('sendMessage', {
      ...this.common(),
      text,
      parse_mode: 'HTML',
      reply_markup: markup,
    })
    await this.collect(message)
  }

  private async sendMedia(item: Media, caption: string, markup?: object) {
    const common = this.common()
    const send = async (kind: MediaKind, input: string | Blob) => {
      const form = toForm({
        ...common,
        caption: caption || undefined,
        parse_mode: caption ? 'HTML' : undefined,
        reply_markup: markup,
        [kind]: typeof input === 'string' ? input : 'attach://file',
      })
      if (typeof input !== 'string') form.append('file', input, (input as File).name ?? 'file')
      return this.host.api.call<Message>(METHODS[kind], form)
    }
    const fileId = telegramFileId(item.element)
    if (fileId) {
      try {
        return await this.collect(await send(item.kind, fileId))
      } catch (e) {
        // A file id of another bot: upload the file itself
        if (!(e instanceof TelegramError) || e.code !== 400 || !item.element.attrs.src) throw e
      }
    }
    const blob = await this.load(item.element)
    try {
      await this.collect(await send(item.kind, blob))
    } catch (e) {
      // Photos have limits on size and shape that documents do not
      if (!(e instanceof TelegramError) || e.code !== 400 || item.kind === 'document') throw e
      await this.collect(await send('document', blob))
    }
  }

  private async sendAlbum(items: Media[], caption: string) {
    const form = new FormData()
    const media = []
    for (let i = 0; i < items.length; i++) {
      const fileId = telegramFileId(items[i].element)
      let ref = fileId
      if (!ref) {
        const blob = await this.load(items[i].element)
        form.append(`file${i}`, blob, (blob as File).name ?? `file${i}`)
        ref = `attach://file${i}`
      }
      media.push({
        type: items[i].kind === 'animation' ? 'video' : items[i].kind,
        media: ref,
        ...i === 0 && caption ? { caption, parse_mode: 'HTML' } : {},
      })
    }
    const fields = toForm({ ...this.common(), media })
    for (const [key, value] of fields) form.append(key, value)
    const messages = await this.host.api.call<Message[]>('sendMediaGroup', form)
    for (const message of messages) await this.collect(message)
  }

  /** The bytes of a file element's src */
  private async load(element: h): Promise<Blob> {
    const src = String(element.attrs.src ?? element.attrs.url ?? '')
    const name = String(element.attrs.title ?? element.attrs.filename ?? '')
    if (!src) throw new Error(`${element.type} 元素缺少 src`)
    if (src.startsWith('base64://')) return named(new Blob([Buffer.from(src.slice(9), 'base64')]), name || 'file')
    if (/^(https?|data):/i.test(src)) {
      const file = await this.host.http.file(src)
      return named(new Blob([file.data], { type: file.type }), name || file.filename || 'file')
    }
    const local = src.startsWith('file:') ? fileURLToPath(src) : src
    return named(new Blob([await readFile(local)]), name || path.basename(local))
  }

  private async collect(message: Message) {
    this.results.push(await decodeMessage(message, { ...this.host.decodeContext, media: undefined }))
  }
}

/** Photos and videos together make albums of up to ten; anything else goes on its own */
function batches(media: Media[]): Media[][] {
  const result: Media[][] = []
  let album: Media[] = []
  for (const item of media) {
    if (item.kind === 'photo' || item.kind === 'video') {
      album.push(item)
      if (album.length === ALBUM_LIMIT) {
        result.push(album)
        album = []
      }
      continue
    }
    if (album.length) result.push(album)
    album = []
    result.push([item])
  }
  if (album.length) result.push(album)
  return result
}

function captionable(batch: Media[]) {
  return batch.length > 1 || (batch[0].kind !== 'sticker' && batch[0].kind !== 'video_note')
}

/** Long text in pieces Telegram takes, cut at line ends where it can be */
export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** Multipart fields: objects as JSON, nothing for undefined */
function toForm(fields: Record<string, unknown>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return form
}

function named(blob: Blob, name: string): Blob {
  return new File([blob], name, { type: blob.type })
}

function telegramFileId(element: h): string | undefined {
  const id = element.attrs.telegramFileId
  return typeof id === 'string' && id ? id : undefined
}

function isGif(attrs: Record<string, any>) {
  return /\.gif($|\?)/i.test(String(attrs.src ?? '')) || attrs.mime === 'image/gif'
}

/** Ogg Opus plays as a voice message; MP3 and M4A as music; anything else as a file */
function audioKind(attrs: Record<string, any>): MediaKind {
  const src = String(attrs.src ?? '').toLowerCase()
  if (/\.(ogg|oga|opus)($|\?)/.test(src) || attrs.mime === 'audio/ogg') return 'voice'
  if (/\.(mp3|m4a)($|\?)/.test(src) || attrs.mime === 'audio/mpeg' || attrs.mime === 'audio/mp4') return 'audio'
  if (src.startsWith('data:audio/ogg')) return 'voice'
  if (src.startsWith('data:audio/mpeg')) return 'audio'
  return 'document'
}
