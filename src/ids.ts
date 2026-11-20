import type { Chat, Message, User } from './types.js'

/**
 * Channel ids, which Bot methods take back as they are:
 *
 * - a private chat: `private:<user id>`, the host's sign of a direct chat
 * - a group, supergroup or channel: `<chat id>` (negative), its guild id as well
 * - a forum topic: `<chat id>/<thread id>`, its guild being `<chat id>`
 *
 * Message ids are Telegram's, which are unique within a chat only; the methods all take the channel with them.
 */

export interface ChatTarget {
  chat_id: string
  message_thread_id?: number
}

const PRIVATE = 'private:'

export function parseChannel(channelId: string): ChatTarget {
  if (channelId.startsWith(PRIVATE)) return { chat_id: channelId.slice(PRIVATE.length) }
  const slash = channelId.indexOf('/')
  if (slash < 0) return { chat_id: channelId }
  const thread = Number(channelId.slice(slash + 1))
  return {
    chat_id: channelId.slice(0, slash),
    message_thread_id: Number.isSafeInteger(thread) ? thread : undefined,
  }
}

/** The guild a channel belongs to; none for a private chat */
export function guildOf(channelId: string): string | undefined {
  if (channelId.startsWith(PRIVATE)) return
  return parseChannel(channelId).chat_id
}

export function channelOf(message: Pick<Message, 'chat' | 'is_topic_message' | 'message_thread_id'>): string {
  if (message.chat.type === 'private') return PRIVATE + message.chat.id
  if (message.is_topic_message && message.message_thread_id) return `${message.chat.id}/${message.message_thread_id}`
  return String(message.chat.id)
}

export function privateChannel(userId: string | number) {
  return PRIVATE + userId
}

/** The display name: first and last name */
export function fullName(user: Pick<User, 'first_name' | 'last_name'> | Pick<Chat, 'first_name' | 'last_name' | 'title'>): string {
  if ('title' in user && user.title) return user.title
  return [user.first_name, user.last_name].filter(Boolean).join(' ')
}
