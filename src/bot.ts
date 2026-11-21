import { h } from '@luckylillia-dev/plugin-sdk'
import type {
  Bot, Context, Feature, Http, NeutralEvent, NeutralList, NeutralResource, SendOptions, Universal,
} from '@luckylillia-dev/plugin-sdk'
import type { TelegramApi } from './api.js'
import { CommandButtons } from './buttons.js'
import {
  decodeCallback, decodeElements, decodeJoinRequest, decodeMessageEvents, decodeMyChatMember, decodeReactions,
  decodeUser, type DecodeContext, type EventData,
} from './decode.js'
import { MessageEncoder, type EncoderHost } from './encode.js'
import { fullName, parseChannel, privateChannel } from './ids.js'
import type { MediaStore } from './media.js'
import type { BotCommand, ChatFullInfo, ChatMember, ChatPermissions, Message, Update, User } from './types.js'

/** Satori's Status, which the SDK exports as a type only */
export const Status = {
  OFFLINE: 0,
  ONLINE: 1,
  CONNECT: 2,
  DISCONNECT: 3,
  RECONNECT: 4,
} as const satisfies Record<string, Universal.Status>

/**
 * `bot.internal`: any Bot API method by its name, taking its parameters as one object, resolving to its result:
 * `internalOf(bot, 'telegram')?.pinChatMessage({ chat_id, message_id })`. `call(method, data)` does the same.
 */
export type TelegramInternal = {
  call<T = any>(method: string, data?: Record<string, unknown> | FormData): Promise<T>
} & Record<string, (data?: Record<string, unknown> | FormData) => Promise<any>>

export interface BotOptions {
  /** Puts the plugins' commands on Telegram's command menu */
  slash: boolean
  media?: MediaStore
}

/** Messages of an album come one by one, this long apart at most */
const ALBUM_WAIT = 1000

const SEND_PERMISSIONS: (keyof ChatPermissions)[] = [
  'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos',
  'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls', 'can_send_other_messages', 'can_add_web_page_previews',
]

const ROLES: Record<ChatMember['status'], string> = {
  creator: 'owner',
  administrator: 'admin',
  member: 'member',
  restricted: 'member',
  left: 'member',
  kicked: 'member',
}

/** One bot token: groups, supergroups (forum topics too), channels and private chats */
export class TelegramBot implements Bot, EncoderHost {
  readonly platform = 'telegram'
  readonly selfId: string
  readonly sid: string
  status: Universal.Status = Status.CONNECT
  // Markdown and cards go as their fallbacks: formatted text, which goes as Telegram HTML
  readonly features: readonly Feature[] = ['message.button', 'message.proactive']
  user: NeutralResource
  readonly internal: TelegramInternal
  readonly buttons = new CommandButtons()
  username?: string
  private sn = 0
  private albums = new Map<string, { timer: ReturnType<typeof setTimeout>; messages: Message[] }>()

  constructor(
    readonly ctx: Context,
    readonly api: TelegramApi,
    readonly http: Http,
    token: string,
    private readonly options: BotOptions,
  ) {
    this.selfId = token.split(':')[0]
    this.sid = `${this.platform}:${this.selfId}`
    this.user = { id: this.selfId, name: this.selfId, is_bot: true }
    this.internal = createInternal(api)
  }

  get decodeContext(): DecodeContext {
    return { selfId: this.selfId, username: this.username, media: this.options.media }
  }

  warn(message: string) {
    this.ctx.logger('telegram').warn(message)
  }

  setStatus(status: Universal.Status) {
    if (this.status === status) return
    this.status = status
    this.ctx.parallel('bot/status', this).catch(e => this.warn(String(e)))
  }

  /** Who the token belongs to; fails on a wrong token */
  async login(signal?: AbortSignal): Promise<User> {
    const me = await this.api.call<User>('getMe', undefined, signal)
    this.username = me.username
    this.user = { ...decodeUser(me), id: this.selfId }
    return me
  }

  event(data: EventData): NeutralEvent {
    return {
      sn: ++this.sn,
      self_id: this.selfId,
      platform: this.platform,
      timestamp: Date.now(),
      login: { sn: 1, user: this.user, platform: this.platform, status: this.status },
      referrer: undefined,
      ...data,
    } as NeutralEvent
  }

  private async dispatch(events: EventData[]) {
    for (const data of events) await this.ctx.bots.dispatch(this, this.event(data))
  }

  /** One update from polling or the webhook */
  async handle(update: Update) {
    const kind = Object.keys(update).find(key => key !== 'update_id')
    if (!kind) return
    await this.dispatch([{ type: 'internal', _type: `telegram/${kind.replace(/_/g, '-')}`, _data: update[kind] }])
    const ctx = this.decodeContext
    const created = update.message ?? update.channel_post
    const edited = update.edited_message ?? update.edited_channel_post
    if (created) {
      if (created.media_group_id) return this.collectAlbum(created)
      return this.dispatch(await decodeMessageEvents(created, 'message-created', ctx))
    }
    if (edited) return this.dispatch(await decodeMessageEvents(edited, 'message-updated', ctx))
    if (update.callback_query) return this.onCallback(update.callback_query)
    if (update.my_chat_member) {
      const event = decodeMyChatMember(update.my_chat_member)
      return event && this.dispatch([event])
    }
    if (update.chat_join_request) return this.dispatch([decodeJoinRequest(update.chat_join_request)])
    if (update.message_reaction) return this.dispatch(decodeReactions(update.message_reaction))
  }

  /** The photos and videos of an album, each a message of its own on Telegram, as one message */
  private collectAlbum(message: Message) {
    const key = `${message.chat.id}:${message.media_group_id}`
    const album = this.albums.get(key)
    if (album) clearTimeout(album.timer)
    const messages = [...album?.messages ?? [], message]
    const timer = setTimeout(() => {
      this.albums.delete(key)
      this.flushAlbum(messages).catch(e => this.warn(`处理相册消息失败: ${(e as Error).message}`))
    }, ALBUM_WAIT)
    this.albums.set(key, { timer, messages })
  }

  private async flushAlbum(messages: Message[]) {
    messages.sort((a, b) => a.message_id - b.message_id)
    const ctx = this.decodeContext
    const parts = await Promise.all(messages.map(m => decodeElements(m, ctx)))
    // One quote, first; the caption (which one message has) before the files
    const quote = parts.flat().find(e => e.type === 'quote')
    const isFile = (e: h) => ['img', 'video', 'audio', 'file'].includes(e.type)
    const rest = parts.flat().filter(e => e.type !== 'quote')
    const text = rest.filter(e => !isFile(e))
    const files = rest.filter(isFile)
    const elements = [...quote ? [quote] : [], ...text, ...files]
    await this.dispatch(await decodeMessageEvents(messages[0], 'message-created', ctx, elements))
  }

  private async onCallback(query: NonNullable<Update['callback_query']>) {
    const command = this.buttons.isCommand(query.data)
    const text = this.buttons.decode(query.data)
    // Until answered, the button shows as loading
    this.api.call('answerCallbackQuery', {
      callback_query_id: query.id,
      text: command && text === undefined ? '按钮已过期，请重新发送指令' : undefined,
    }).catch(e => this.warn(`回应按钮点击失败: ${(e as Error).message}`))
    const event = decodeCallback(query)
    if (!command) return this.dispatch([event])
    if (text === undefined) return
    // A command button: what it names, as if the user had sent it
    await this.dispatch([{
      type: 'message-created',
      channel: event.channel,
      guild: event.guild,
      user: event.user,
      ...event.guild ? { member: { user: event.user, nick: event.user?.nick } } : {},
      message: { id: event.message!.id, content: h.escape(text), created_at: event.timestamp },
      timestamp: event.timestamp,
    }])
  }

  dispose() {
    for (const { timer } of this.albums.values()) clearTimeout(timer)
    this.albums.clear()
  }

  async sendMessage(channelId: string, content: h.Fragment, options: SendOptions = {}): Promise<NeutralResource[]> {
    const elements = h.normalize(content)
    if (options.quote) elements.unshift(h('quote', { id: options.quote }))
    const outgoing = await this.ctx.bots.beforeSend(this, channelId, elements, options)
    if (!outgoing.length) return []
    return new MessageEncoder(this, channelId).send(outgoing)
  }

  sendPrivateMessage(userId: string, content: h.Fragment, options?: SendOptions) {
    return this.sendMessage(privateChannel(userId), content, options)
  }

  async deleteMessage(channelId: string, messageId: string) {
    await this.api.call('deleteMessage', { chat_id: parseChannel(channelId).chat_id, message_id: Number(messageId) })
  }

  async getUser(userId: string): Promise<NeutralResource> {
    const chat = await this.api.call<ChatFullInfo>('getChat', { chat_id: userId })
    const nick = fullName(chat)
    return { id: String(chat.id), name: chat.username || nick, nick }
  }

  async getGuild(guildId: string): Promise<NeutralResource> {
    const chat = await this.api.call<ChatFullInfo>('getChat', { chat_id: guildId })
    return { id: String(chat.id), name: chat.title }
  }

  async getChannel(channelId: string): Promise<NeutralResource> {
    const { chat_id } = parseChannel(channelId)
    const chat = await this.api.call<ChatFullInfo>('getChat', { chat_id })
    if (chat.type === 'private') return { id: channelId, type: 1, name: fullName(chat) }
    return { id: channelId, type: 0, name: chat.title }
  }

  /** Telegram lists no forum topics: the group itself */
  async getChannelList(guildId: string): Promise<NeutralList> {
    return { data: [await this.getChannel(guildId)] }
  }

  async createDirectChannel(userId: string): Promise<NeutralResource> {
    return { id: privateChannel(userId), type: 1 }
  }

  /** Leaves the group or channel */
  async deleteChannel(channelId: string) {
    const { chat_id } = parseChannel(channelId)
    if (channelId.startsWith('private:')) return
    await this.api.call('leaveChat', { chat_id })
  }

  async muteChannel(channelId: string, guildId?: string, enable = true) {
    const chat_id = guildId ?? parseChannel(channelId).chat_id
    const chat = await this.api.call<ChatFullInfo>('getChat', { chat_id })
    const permissions: ChatPermissions = { ...chat.permissions }
    for (const key of SEND_PERMISSIONS) permissions[key] = !enable
    await this.api.call('setChatPermissions', { chat_id, permissions, use_independent_chat_permissions: true })
  }

  async getGuildMember(guildId: string, userId: string): Promise<NeutralResource> {
    return decodeMember(await this.api.call<ChatMember>('getChatMember', { chat_id: guildId, user_id: Number(userId) }))
  }

  /** Telegram lists the administrators only */
  async getGuildMemberList(guildId: string): Promise<NeutralList> {
    const members = await this.api.call<ChatMember[]>('getChatAdministrators', { chat_id: guildId })
    return { data: members.map(decodeMember) }
  }

  async kickGuildMember(guildId: string, userId: string, permanent?: boolean) {
    const user_id = Number(userId)
    await this.api.call('banChatMember', { chat_id: guildId, user_id })
    // A kick that is no ban: let them join again
    if (!permanent) await this.api.call('unbanChatMember', { chat_id: guildId, user_id, only_if_banned: true })
  }

  /** `duration` in milliseconds; 0 lifts it. Telegram takes under 30 seconds or over 366 days as forever */
  async muteGuildMember(guildId: string, userId: string, duration: number) {
    const user_id = Number(userId)
    if (duration > 0) {
      const permissions: ChatPermissions = {}
      for (const key of SEND_PERMISSIONS) permissions[key] = false
      await this.api.call('restrictChatMember', {
        chat_id: guildId,
        user_id,
        permissions,
        use_independent_chat_permissions: true,
        until_date: Math.floor((Date.now() + Math.max(duration, 30_000)) / 1000),
      })
      return
    }
    // Back to what everyone in the group may do
    const chat = await this.api.call<ChatFullInfo>('getChat', { chat_id: guildId })
    await this.api.call('restrictChatMember', {
      chat_id: guildId,
      user_id,
      permissions: chat.permissions ?? Object.fromEntries(SEND_PERMISSIONS.map(key => [key, true])),
      use_independent_chat_permissions: true,
    })
  }

  /** `messageId` is the request event's, `<chat id>@<user id>` */
  async handleGuildMemberRequest(messageId: string, approve: boolean) {
    const at = messageId.lastIndexOf('@')
    if (at < 0) throw new Error(`不是入群申请的消息 ID: ${messageId}`)
    await this.api.call(approve ? 'approveChatJoinRequest' : 'declineChatJoinRequest', {
      chat_id: messageId.slice(0, at),
      user_id: Number(messageId.slice(at + 1)),
    })
  }

  async createReaction(channelId: string, messageId: string, emoji: string) {
    await this.api.call('setMessageReaction', {
      chat_id: parseChannel(channelId).chat_id,
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
    })
  }

  /** A bot has one reaction per message: this takes it back */
  async deleteReaction(channelId: string, messageId: string) {
    await this.api.call('setMessageReaction', {
      chat_id: parseChannel(channelId).chat_id,
      message_id: Number(messageId),
      reaction: [],
    })
  }

  /** The commands whose names Telegram takes: 1 to 32 of a-z, 0-9 and _ */
  async updateCommands(commands: Universal.Command[]) {
    if (!this.options.slash) return
    const menu: BotCommand[] = []
    for (const command of commands) {
      const name = command.name.toLowerCase()
      if (!/^[a-z0-9_]{1,32}$/.test(name)) continue
      const description = command.description?.[''] || Object.values(command.description ?? {})[0] || name
      menu.push({ command: name, description: description.slice(0, 256) })
    }
    if (menu.length) await this.api.call('setMyCommands', { commands: menu.slice(0, 100) })
    else await this.api.call('deleteMyCommands', {})
  }
}

function decodeMember(member: ChatMember): NeutralResource {
  const user = decodeUser(member.user)
  const role = ROLES[member.status]
  return { user, nick: member.custom_title || user.nick, roles: [{ id: role, name: role }] }
}

function createInternal(api: TelegramApi): TelegramInternal {
  const call = (method: string, data?: Record<string, unknown> | FormData) => api.call(method, data)
  return new Proxy({ call } as TelegramInternal, {
    get(target, key) {
      // Not a thenable, nor anything else a caller probes for
      if (typeof key !== 'string' || key === 'then' || key === 'toJSON' || key === 'constructor') return undefined
      return target[key] ?? ((data?: Record<string, unknown> | FormData) => api.call(key, data))
    },
  })
}
