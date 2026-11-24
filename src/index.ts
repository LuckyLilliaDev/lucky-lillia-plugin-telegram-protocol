import type { Context } from '@luckylillia-dev/plugin-sdk'
import { sleep, TelegramApi, TelegramError } from './api.js'
import { Status, TelegramBot, type TelegramInternal } from './bot.js'
import { Config, DEFAULT_ENDPOINT, TOKEN_PATTERN } from './config.js'
import { MediaStore } from './media.js'
import { poll, UpdateQueue, webhook, webhookSecret } from './receive.js'
import { registerTestRoute } from './testRoute.js'

export { Config }
export { TelegramBot, TelegramError, type TelegramInternal }
export type * as Telegram from './types.js'

export const name = 'telegram'
export const inject = ['bots', 'http', 'webuiServer']

declare module '@luckylillia-dev/plugin-sdk' {
  interface PlatformInternals {
    telegram: TelegramInternal
  }
}

/** Long enough for an upload; long polls end well before */
const HTTP_TIMEOUT = 120_000
const LOGIN_TIMEOUT = 20_000
const CLEANUP_INTERVAL = 12 * 60 * 60 * 1000

/** One Telegram bot per entry, by its token; add another entry for another bot. */
export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('telegram')
  registerTestRoute(ctx, () => config)
  const token = config.token.trim()
  // Waits for its settings instead of failing: saving them starts it
  if (!token) {
    logger.info('还没有填写 Bot Token，在设置中填好保存后连接')
    return
  }
  if (!TOKEN_PATTERN.test(token)) throw new Error('Bot Token 格式不对，应形如 123456789:AAxxxx（从 @BotFather 获得）')

  // Automatically uses the builtin「代理」plugin when enabled
  const http = ctx.http.extend({ timeout: HTTP_TIMEOUT })
  const api = new TelegramApi(http, { token, endpoint: config.endpoint.trim() || DEFAULT_ENDPOINT })
  const sid = `telegram:${token.split(':')[0]}`
  const media = config.mediaMaxSize > 0
    ? new MediaStore(api, () => ctx.storage.dir('bot', sid), config.mediaMaxSize, message => logger.warn(message))
    : undefined
  const bot = new TelegramBot(ctx, api, http, token, { slash: config.slash, media })

  // A wrong token fails the entry, so its card says why; a network problem is retried below
  try {
    const me = await bot.login(AbortSignal.timeout(LOGIN_TIMEOUT))
    logger.info('Telegram 机器人 @%s (%s) 已登录', me.username ?? '', bot.selfId)
  } catch (e) {
    if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) throw new Error('Bot Token 无效，请到 @BotFather 核对')
    logger.warn('连接 Telegram 失败: %s，将在后台重试（国内网络请检查「代理」插件是否已启用）', (e as Error).message)
  }

  ctx.bots.register(bot)
  const controller = new AbortController()
  const { signal } = controller
  const queue = new UpdateQueue(bot, logger)

  ctx.effect(() => {
    run().catch(e => logger.error(e))
    const cleanup = media && setInterval(() => {
      media.cleanup(config.mediaCacheDays).catch(e => logger.warn('清理媒体缓存失败: %s', (e as Error).message))
    }, CLEANUP_INTERVAL)
    return () => {
      controller.abort()
      if (cleanup) clearInterval(cleanup)
      bot.dispose()
    }
  })

  async function run() {
    await media?.cleanup(config.mediaCacheDays).catch(e => logger.warn('清理媒体缓存失败: %s', (e as Error).message))
    // Not logged in yet: keep trying before receiving, so @mentions of the bot are recognized
    for (let failures = 1; !bot.username && !signal.aborted; failures++) {
      try {
        await bot.login(signal)
        logger.info('Telegram 机器人 @%s (%s) 已登录', bot.username ?? '', bot.selfId)
      } catch (e) {
        if (signal.aborted) return
        if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) {
          logger.error('Bot Token 无效，请到 @BotFather 核对')
          bot.setStatus(Status.OFFLINE)
          return
        }
        bot.setStatus(Status.RECONNECT)
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), signal)
      }
    }
    if (signal.aborted) return
    if (config.protocol === 'webhook') {
      if (!config.selfUrl.trim()) {
        logger.error('Webhook 模式需要填写公网地址')
        bot.setStatus(Status.OFFLINE)
        return
      }
      await webhook(ctx, bot, api, queue, { selfUrl: config.selfUrl.trim(), secret: webhookSecret(token, config.secretToken) }, signal, logger)
    } else {
      await poll(bot, api, queue, config.pollingTimeout, signal, logger)
    }
  }
}
