import { Schema } from '@luckylillia/plugin-sdk'

export interface PollingConfig {
  protocol: 'polling'
  /** Seconds the Bot API holds a getUpdates open */
  pollingTimeout: number
}

export interface WebhookConfig {
  protocol: 'webhook'
  /** Where Telegram reaches this WebUI from the internet, e.g. https://bot.example.com */
  selfUrl: string
  /** Sent back by Telegram with each update; by default one made from the token */
  secretToken: string
}

export type Config = {
  token: string
  endpoint: string
  proxy: string
  slash: boolean
  mediaMaxSize: number
  mediaCacheDays: number
} & (PollingConfig | WebhookConfig)

export const TOKEN_PATTERN = /^\d+:[\w-]{30,}$/

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    token: Schema.string().role('secret').default('')
      .description('Bot Token：在 Telegram 里找 @BotFather 创建机器人后得到，形如 123456789:AA...'),
  }),
  Schema.union([
    Schema.object({
      protocol: Schema.const('polling').default('polling').description('长轮询'),
      pollingTimeout: Schema.natural().min(1).max(50).default(30)
        .description('每次长轮询等待新消息的秒数'),
    }).description('长轮询：主动向 Telegram 拉取消息，不需要公网地址'),
    Schema.object({
      protocol: Schema.const('webhook').required().description('Webhook'),
      selfUrl: Schema.string().role('link').default('')
        .description('公网 HTTPS 地址，指向本 WebUI，例如 https://bot.example.com；Telegram 会推送到 <地址>/telegram/webhook/<机器人 ID>'),
      secretToken: Schema.string().role('secret').default('')
        .description('Webhook 校验口令：留空则由 Token 生成'),
    }).description('Webhook：由 Telegram 推送消息，需要公网 HTTPS 地址'),
  ]).description('接收方式'),
  Schema.object({
    proxy: Schema.string().default('')
      .description('代理地址（http、https 或 socks5）：留空则使用「代理」插件的设置，填 direct 表示直连'),
    endpoint: Schema.string().role('link').default('https://api.telegram.org')
      .description('Bot API 地址：自建 telegram-bot-api 服务或反向代理时修改'),
  }).description('网络'),
  Schema.object({
    slash: Schema.boolean().default(true)
      .description('把插件指令同步到 Telegram 的「/」指令菜单（只同步名称为英文、数字和下划线的指令）'),
    mediaMaxSize: Schema.natural().min(0).max(20).default(20)
      .description('收到的图片、语音、视频和文件，不超过多少 MB 时下载到本地供插件使用（Bot API 最多可下载 20 MB）'),
    mediaCacheDays: Schema.natural().min(1).default(7)
      .description('下载的媒体文件保留天数'),
  }).description('消息'),
]) as Schema<Config>
