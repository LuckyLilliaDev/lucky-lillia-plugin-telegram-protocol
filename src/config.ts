import { Schema } from '@luckylillia-dev/plugin-sdk'

export type ReceiveProtocol = 'polling' | 'webhook'

export interface Config {
  token: string
  protocol: ReceiveProtocol
  /** Seconds the Bot API holds a getUpdates open */
  pollingTimeout: number
  /** Where Telegram reaches this WebUI from the internet, e.g. https://bot.example.com */
  selfUrl: string
  /** Sent back by Telegram with each update; by default one made from the token */
  secretToken: string
  endpoint: string
  slash: boolean
  mediaMaxSize: number
  mediaCacheDays: number
}

export const DEFAULT_ENDPOINT = 'https://api.telegram.org'
export const TOKEN_PATTERN = /^\d+:[\w-]{30,}$/

// Root Schema.object so WebUI SchemaForm renders native inputs instead of falling back to raw JSON.
export const Config: Schema<Config> = Schema.object({
  token: Schema.string().role('secret').default('')
    .description('Bot Token：在 Telegram 里找 @BotFather 创建机器人后得到，形如 123456789:AA...'),
  protocol: Schema.union([
    Schema.const('polling').description('长轮询（推荐，主动拉取消息，不需要公网地址）'),
    Schema.const('webhook').description('Webhook（由 Telegram 推送消息，需要公网 HTTPS 地址）'),
  ]).default('polling').description('接收方式：选择从 Telegram 接收消息的方式'),
  pollingTimeout: Schema.natural().min(1).max(50).default(30)
    .description('长轮询等待秒数：每次长轮询等待新消息的秒数（1–50 秒）'),
  selfUrl: Schema.string().role('link').default('')
    .description('公网 HTTPS 地址：指向本 WebUI，例如 https://bot.example.com；Telegram 会推送到 <地址>/telegram/webhook/<机器人 ID>'),
  secretToken: Schema.string().role('secret').default('')
    .description('Webhook 校验口令：用于校验 Telegram 推送请求，留空则由 Token 自动生成'),
  endpoint: Schema.string().role('link').default(DEFAULT_ENDPOINT)
    .description('Bot API 地址：默认官方接口，自建 telegram-bot-api 服务或反向代理时修改'),
  slash: Schema.boolean().default(true)
    .description('同步指令菜单：把插件指令同步到 Telegram 的「/」指令菜单（只同步名称为英文、数字和下划线的指令）'),
  mediaMaxSize: Schema.natural().min(0).max(20).default(20)
    .description('媒体下载上限（MB）：收到的图片、语音、视频和文件不超过此大小时下载到本地供插件使用（0 为不下载，Bot API 最多 20 MB）'),
  mediaCacheDays: Schema.natural().min(1).default(7)
    .description('媒体缓存保留天数：下载到本地的媒体文件保留天数'),
}) as Schema<Config>
