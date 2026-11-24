/**
 * The Telegram Bot API objects this plugin reads, trimmed to the fields it uses.
 * https://core.telegram.org/bots/api
 */

export interface User {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
  can_join_groups?: boolean
  can_read_all_group_messages?: boolean
}

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel'

export interface Chat {
  id: number
  type: ChatType
  title?: string
  username?: string
  first_name?: string
  last_name?: string
  is_forum?: boolean
}

/** What getChat returns */
export interface ChatFullInfo extends Chat {
  permissions?: ChatPermissions
}

export interface ChatPermissions {
  can_send_messages?: boolean
  can_send_audios?: boolean
  can_send_documents?: boolean
  can_send_photos?: boolean
  can_send_videos?: boolean
  can_send_video_notes?: boolean
  can_send_voice_notes?: boolean
  can_send_polls?: boolean
  can_send_other_messages?: boolean
  can_add_web_page_previews?: boolean
  can_change_info?: boolean
  can_invite_users?: boolean
  can_pin_messages?: boolean
  can_manage_topics?: boolean
}

export type MessageEntityType =
  | 'mention' | 'hashtag' | 'cashtag' | 'bot_command' | 'url' | 'email' | 'phone_number'
  | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'spoiler' | 'blockquote' | 'expandable_blockquote'
  | 'code' | 'pre' | 'text_link' | 'text_mention' | 'custom_emoji'

export interface MessageEntity {
  type: MessageEntityType
  /** In UTF-16 code units, as JavaScript strings count */
  offset: number
  length: number
  url?: string
  user?: User
  language?: string
}

export interface PhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

/** Any of the files a message carries: they all have these */
export interface FileBase {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_name?: string
  mime_type?: string
}

export interface Sticker extends FileBase {
  type: 'regular' | 'mask' | 'custom_emoji'
  is_animated: boolean
  is_video: boolean
  emoji?: string
  set_name?: string
}

export interface Message {
  message_id: number
  message_thread_id?: number
  from?: User
  /** Who posted it in the name of a chat (anonymous admins, channels) */
  sender_chat?: Chat
  date: number
  edit_date?: number
  chat: Chat
  is_topic_message?: boolean
  reply_to_message?: Message
  media_group_id?: string
  text?: string
  entities?: MessageEntity[]
  caption?: string
  caption_entities?: MessageEntity[]
  photo?: PhotoSize[]
  sticker?: Sticker
  animation?: FileBase
  audio?: FileBase
  document?: FileBase
  video?: FileBase
  video_note?: FileBase
  voice?: FileBase
  contact?: { phone_number: string; first_name: string; last_name?: string }
  dice?: { emoji: string; value: number }
  poll?: { question: string }
  location?: { latitude: number; longitude: number }
  venue?: { title: string; address: string; location: { latitude: number; longitude: number } }
  new_chat_members?: User[]
  left_chat_member?: User
  forum_topic_created?: { name: string }
}

export interface CallbackQuery {
  id: string
  from: User
  message?: Message
  data?: string
}

export interface ChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
  user: User
  custom_title?: string
  until_date?: number
}

export interface ChatMemberUpdated {
  chat: Chat
  from: User
  date: number
  old_chat_member: ChatMember
  new_chat_member: ChatMember
}

export interface ChatJoinRequest {
  chat: Chat
  from: User
  user_chat_id: number
  date: number
  bio?: string
}

export type ReactionType =
  | { type: 'emoji'; emoji: string }
  | { type: 'custom_emoji'; custom_emoji_id: string }
  | { type: 'paid' }

export interface MessageReactionUpdated {
  chat: Chat
  message_id: number
  user?: User
  actor_chat?: Chat
  date: number
  old_reaction: ReactionType[]
  new_reaction: ReactionType[]
}

export interface Update {
  update_id: number
  message?: Message
  edited_message?: Message
  channel_post?: Message
  edited_channel_post?: Message
  callback_query?: CallbackQuery
  my_chat_member?: ChatMemberUpdated
  chat_member?: ChatMemberUpdated
  chat_join_request?: ChatJoinRequest
  message_reaction?: MessageReactionUpdated
  [kind: string]: unknown
}

export interface File {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

export interface WebhookInfo {
  url: string
  pending_update_count: number
  last_error_message?: string
}

export interface BotCommand {
  command: string
  description: string
}

export interface InlineKeyboardButton {
  text: string
  url?: string
  callback_data?: string
}

/** The updates this plugin asks for: chat_member and the like need admin rights and are left out */
export const ALLOWED_UPDATES = [
  'message', 'edited_message', 'channel_post', 'edited_channel_post',
  'callback_query', 'my_chat_member', 'chat_join_request', 'message_reaction',
]
