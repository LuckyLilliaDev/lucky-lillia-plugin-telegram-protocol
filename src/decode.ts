import { h } from '@luckylillia-dev/plugin-sdk'
import type { NeutralEvent, NeutralResource, NeutralUser } from '@luckylillia-dev/plugin-sdk'
import type { MediaKind } from './encode.js'
import { channelOf, fullName, privateChannel } from './ids.js'
import type { MediaStore } from './media.js'
import type {
  CallbackQuery, Chat, ChatJoinRequest, ChatMemberUpdated, FileBase, Message, MessageEntity,
  MessageReactionUpdated, ReactionType, User,
} from './types.js'

/** What decoding needs to know of the bot */
export interface DecodeContext {
  selfId: string
  /** The bot's @username, without the @ */
  username?: string
  /** Downloads received files; without it they become placeholders */
  media?: MediaStore
}

/** An event before the bot stamps it with sn, self_id, platform and login */
export type EventData = Partial<NeutralEvent> & { type: string }

/** Satori's channel types */
const TEXT = 0
const DIRECT = 1

/** Telegram's sender of messages that anonymous group admins post */
const GROUP_ANONYMOUS_BOT = 1087968824

/** name: the @username where there is one, as Satori's; nick: what Telegram shows */
export function decodeUser(user: User): NeutralUser {
  const nick = fullName(user)
  return { id: String(user.id), name: user.username || nick, nick, is_bot: user.is_bot }
}

function chatAsUser(chat: Chat): NeutralUser {
  const nick = fullName(chat)
  return { id: String(chat.id), name: chat.username || nick, nick }
}

/** Who sent it: a chat posting in its own name (channel posts, anonymous admins) stands in for the user */
export function senderOf(message: Message): NeutralUser {
  if (message.sender_chat && (!message.from || message.from.id === GROUP_ANONYMOUS_BOT)) return chatAsUser(message.sender_chat)
  return message.from ? decodeUser(message.from) : chatAsUser(message.chat)
}

/** The channel, guild and member fields of an event in this chat */
export function place(message: Pick<Message, 'chat' | 'is_topic_message' | 'message_thread_id'>) {
  const { chat } = message
  const channel = { id: channelOf(message), type: chat.type === 'private' ? DIRECT : TEXT, name: chat.type === 'private' ? undefined : chat.title }
  if (chat.type === 'private') return { channel }
  return { channel, guild: { id: String(chat.id), name: chat.title } }
}

/** Text with its entities as Satori elements */
export function decodeText(text: string | undefined, entities: MessageEntity[] = [], ctx: DecodeContext): h[] {
  if (!text) return []
  const points = new Set([0, text.length])
  for (const e of entities) {
    points.add(e.offset)
    points.add(e.offset + e.length)
  }
  const sorted = [...points].filter(p => p >= 0 && p <= text.length).sort((a, b) => a - b)
  const result: h[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i], end = sorted[i + 1]
    const content = text.slice(start, end)
    const active = entities.filter(e => e.offset <= start && e.offset + e.length >= end)
    result.push(decodeSegment(content, active, ctx))
  }
  return result
}

function decodeSegment(content: string, active: MessageEntity[], ctx: DecodeContext): h {
  const whole = (type: MessageEntity['type']) => active.find(e => e.type === type)
  const mention = whole('text_mention')
  if (mention?.user) return h('at', { id: String(mention.user.id), name: fullName(mention.user) })
  if (whole('mention')) {
    const name = content.slice(1)
    if (ctx.username && name.toLowerCase() === ctx.username.toLowerCase()) return h('at', { id: ctx.selfId, name })
    return h.text(content)
  }
  if (whole('bot_command')) {
    // `/start@ThisBot` reads as `/start`; a command for another bot stays as it is, matching none here
    const at = content.indexOf('@')
    if (at > 0 && ctx.username && content.slice(at + 1).toLowerCase() === ctx.username.toLowerCase()) {
      return h.text(content.slice(0, at))
    }
    return h.text(content)
  }
  let element = h.text(content)
  if (whole('code') || whole('pre')) element = h('code', {}, element)
  if (whole('bold')) element = h('b', {}, element)
  if (whole('italic')) element = h('i', {}, element)
  if (whole('underline')) element = h('u', {}, element)
  if (whole('strikethrough')) element = h('s', {}, element)
  if (whole('spoiler')) element = h('spl', {}, element)
  const link = whole('text_link')
  if (link?.url) element = h('a', { href: link.url }, element)
  return element
}

/**
 * A file as an element of `type`, or a placeholder when it is too big or not downloaded. `telegramFileId` and
 * `telegramType` let this plugin send it again without uploading it, as what it was.
 */
async function file(type: 'img' | 'audio' | 'video' | 'file', kind: MediaKind, data: FileBase, label: string, ctx: DecodeContext) {
  const src = await ctx.media?.url(data)
  if (!src) return h.text(`[${label}${data.file_name ? ' ' + data.file_name : ''}]`)
  return h(type, {
    src,
    telegramFileId: data.file_id,
    telegramType: kind,
    ...data.file_name ? { title: data.file_name } : {},
  })
}

/** What the message carries besides its text */
async function decodeAttachment(message: Message, ctx: DecodeContext): Promise<h | undefined> {
  if (message.photo?.length) {
    const largest = message.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    return file('img', 'photo', largest, '图片', ctx)
  }
  if (message.sticker) {
    const { sticker } = message
    const label = `贴纸${sticker.emoji ? ' ' + sticker.emoji : ''}`
    // Animated stickers are Lottie (.tgs), which nothing else shows
    if (sticker.is_animated) return h.text(`[${label}]`)
    return file(sticker.is_video ? 'video' : 'img', 'sticker', sticker, label, ctx)
  }
  if (message.animation) return file('video', 'animation', message.animation, '动图', ctx)
  if (message.video) return file('video', 'video', message.video, '视频', ctx)
  if (message.video_note) return file('video', 'video_note', message.video_note, '视频', ctx)
  if (message.voice) return file('audio', 'voice', message.voice, '语音', ctx)
  if (message.audio) return file('audio', 'audio', message.audio, '音频', ctx)
  if (message.document) return file('file', 'document', message.document, '文件', ctx)
  if (message.contact) return h.text(`[联系人 ${fullName(message.contact)} ${message.contact.phone_number}]`)
  if (message.venue) return h.text(`[位置 ${message.venue.title} ${message.venue.address}]`)
  if (message.location) return h.text(`[位置 ${message.location.latitude},${message.location.longitude}]`)
  if (message.dice) return h.text(`[${message.dice.emoji} ${message.dice.value}]`)
  if (message.poll) return h.text(`[投票 ${message.poll.question}]`)
}

/** Every reply in a topic replies to the message that opened it, which is no quote */
function quoted(message: Message): Message | undefined {
  const reply = message.reply_to_message
  if (!reply) return
  if (message.is_topic_message && reply.message_id === message.message_thread_id) return
  return reply
}

/** The message's elements: a quote of what it replies to, its text first (commands start there), then the file */
export async function decodeElements(message: Message, ctx: DecodeContext): Promise<h[]> {
  const elements: h[] = []
  const reply = quoted(message)
  if (reply) elements.push(h('quote', { id: String(reply.message_id) }))
  elements.push(...decodeText(message.text ?? message.caption, message.text ? message.entities : message.caption_entities, ctx))
  const attachment = await decodeAttachment(message, ctx)
  if (attachment) {
    if (message.caption) elements.push(h.text(' '))
    elements.push(attachment)
  }
  return elements
}

/** The quoted message as a resource: its text and placeholders, nothing downloaded */
async function decodeQuote(message: Message, ctx: DecodeContext): Promise<NeutralResource> {
  const elements = await decodeElements({ ...message, reply_to_message: undefined }, { ...ctx, media: undefined })
  return { id: String(message.message_id), content: elements.join(''), user: senderOf(message) }
}

export async function decodeMessage(message: Message, ctx: DecodeContext, elements?: h[]): Promise<NeutralResource> {
  elements ??= await decodeElements(message, ctx)
  const reply = quoted(message)
  return {
    id: String(message.message_id),
    content: elements.join(''),
    created_at: message.date * 1000,
    ...reply ? { quote: await decodeQuote(reply, ctx) } : {},
  }
}

/** A message, edited or not, as its event; service messages (members joining and leaving) as theirs */
export async function decodeMessageEvents(message: Message, type: 'message-created' | 'message-updated', ctx: DecodeContext, elements?: h[]): Promise<EventData[]> {
  const where = place(message)
  if (message.new_chat_members?.length || message.left_chat_member) {
    const operator = message.from ? decodeUser(message.from) : undefined
    const joined = (message.new_chat_members ?? []).map(user => ({ type: 'guild-member-added', user }))
    const left = message.left_chat_member ? [{ type: 'guild-member-removed', user: message.left_chat_member }] : []
    return [...joined, ...left].map(({ type, user }) => {
      const decoded = decodeUser(user)
      return { type, ...where, user: decoded, member: { user: decoded }, operator, timestamp: message.date * 1000 }
    })
  }
  const user = senderOf(message)
  return [{
    type,
    ...where,
    user,
    ...where.guild ? { member: { user, nick: user.nick } } : {},
    message: await decodeMessage(message, ctx, elements),
    timestamp: (type === 'message-updated' && message.edit_date ? message.edit_date : message.date) * 1000,
  }]
}

/** The bot joined or left a group or channel; in private chats, a user blocking it, which is no event */
export function decodeMyChatMember(update: ChatMemberUpdated): EventData | undefined {
  if (update.chat.type === 'private') return
  const was = isIn(update.old_chat_member.status)
  const now = isIn(update.new_chat_member.status)
  if (was === now) return
  const where = place({ chat: update.chat })
  return { type: now ? 'guild-added' : 'guild-removed', ...where, operator: decodeUser(update.from), timestamp: update.date * 1000 }
}

function isIn(status: string) {
  return status === 'creator' || status === 'administrator' || status === 'member' || status === 'restricted'
}

/** Answered by handleGuildMemberRequest with the message id, `<chat id>@<user id>` */
export function decodeJoinRequest(request: ChatJoinRequest): EventData {
  const user = decodeUser(request.from)
  return {
    type: 'guild-member-request',
    ...place({ chat: request.chat }),
    user,
    member: { user },
    message: { id: `${request.chat.id}@${request.from.id}`, content: request.bio ?? '' },
    timestamp: request.date * 1000,
  }
}

export function decodeReactions(update: MessageReactionUpdated): EventData[] {
  const user = update.user ? decodeUser(update.user) : update.actor_chat ? chatAsUser(update.actor_chat) : undefined
  const key = (r: ReactionType) => r.type === 'emoji' ? r.emoji : r.type === 'custom_emoji' ? r.custom_emoji_id : 'paid'
  const before = new Set(update.old_reaction.map(key))
  const after = new Set(update.new_reaction.map(key))
  const where = place({ chat: update.chat })
  const message = { id: String(update.message_id) }
  const events: EventData[] = []
  for (const id of after) if (!before.has(id)) events.push({ type: 'reaction-added', ...where, user, message, emoji: { id, name: id } })
  for (const id of before) if (!after.has(id)) events.push({ type: 'reaction-removed', ...where, user, message, emoji: { id, name: id } })
  return events.map(event => ({ ...event, timestamp: update.date * 1000 }))
}

/** A click on a callback button; where the message with the button was */
export function decodeCallback(query: CallbackQuery): EventData {
  const user = decodeUser(query.from)
  const where = query.message ? place(query.message) : { channel: { id: privateChannel(query.from.id), type: DIRECT } }
  return {
    type: 'interaction/button',
    ...where,
    user,
    button: { id: query.data ?? '' },
    message: { id: query.message ? String(query.message.message_id) : query.id },
    timestamp: Date.now(),
  }
}
