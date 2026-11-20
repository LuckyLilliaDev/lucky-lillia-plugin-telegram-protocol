import { createHash } from 'node:crypto'
import type { Context } from '@luckylillia/plugin-sdk'
import { sleep, TelegramError, type TelegramApi } from './api.js'
import { Status, type TelegramBot } from './bot.js'
import { ALLOWED_UPDATES, type Update, type WebhookInfo } from './types.js'

type Logger = ReturnType<Context['logger']>

/** Messages older than this when the plugin started are not handled: no answering stale commands */
export const STALE_AFTER = 5 * 60

/** When it happened, in seconds; undefined for updates that stay valid (join requests, button clicks) */
function dateOf(update: Update): number | undefined {
  const message = update.message ?? update.channel_post
  if (message) return message.date
  const edited = update.edited_message ?? update.edited_channel_post
  if (edited) return edited.edit_date ?? edited.date
  return update.my_chat_member?.date ?? update.message_reaction?.date
}

/**
 * Hands updates to the bot one after another, so plugins see messages in order. What waited for the bot while it
 * was away is handled, except messages from more than STALE_AFTER before it started.
 */
export class UpdateQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly since: number
  private skipped = 0

  constructor(private readonly bot: TelegramBot, private readonly logger: Logger, startedAt = Date.now()) {
    this.since = Math.floor(startedAt / 1000) - STALE_AFTER
  }

  push(update: Update) {
    const date = dateOf(update)
    if (date !== undefined && date < this.since) {
      if (!this.skipped++) this.logger.info('跳过机器人离线期间超过 %d 分钟的旧消息', STALE_AFTER / 60)
      return
    }
    this.tail = this.tail.then(() => this.bot.handle(update)).catch((e) => {
      this.logger.warn('处理更新 %d 失败: %s', update.update_id, (e as Error).message)
    })
  }

  /** Resolves once what was pushed so far is handled */
  idle() {
    return this.tail
  }
}

function backoff(failures: number) {
  return Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5))
}

/** Long polling with getUpdates until `signal` aborts; the queue leaves out stale messages. */
export async function poll(bot: TelegramBot, api: TelegramApi, queue: UpdateQueue, timeout: number, signal: AbortSignal, logger: Logger) {
  let offset: number | undefined
  let failures = 0
  while (!signal.aborted) {
    try {
      if (offset === undefined) {
        // getUpdates fails while a webhook is set
        const info = await api.call<WebhookInfo>('getWebhookInfo', undefined, signal)
        if (info.url) {
          logger.info('已移除之前设置的 Webhook，改用长轮询')
          await api.call('deleteWebhook', {}, signal)
        }
        offset = 0
      }
      const updates = await api.call<Update[]>('getUpdates', { offset, timeout, allowed_updates: ALLOWED_UPDATES }, signal)
      if (failures) logger.info('已重新连上 Telegram')
      failures = 0
      bot.setStatus(Status.ONLINE)
      for (const update of updates) {
        offset = update.update_id + 1
        queue.push(update)
      }
    } catch (e) {
      if (signal.aborted) return
      if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) {
        logger.error('Bot Token 无效，已停止接收消息: %s', e.description)
        bot.setStatus(Status.OFFLINE)
        return
      }
      failures++
      bot.setStatus(Status.RECONNECT)
      const delay = backoff(failures)
      if (e instanceof TelegramError && e.code === 409) {
        logger.warn('另一个程序正在用这个 Token 接收消息（%s），%d 秒后重试', e.description, delay / 1000)
      } else {
        logger.warn('拉取消息失败: %s，%d 秒后重试', (e as Error).message, delay / 1000)
      }
      await sleep(delay, signal)
    }
  }
}

export const WEBHOOK_PREFIX = '/telegram/webhook/'

/** The default secret: derived from the token, so it stays the same across restarts */
export function webhookSecret(token: string, configured: string) {
  if (configured.trim()) return configured.trim()
  return createHash('sha256').update('luckylillia-telegram:' + token).digest('base64url').slice(0, 48)
}

/**
 * Serves `/telegram/webhook/<bot id>` outside the WebUI login, checking Telegram's secret header, and points the
 * bot's webhook there.
 */
export async function webhook(
  ctx: Context, bot: TelegramBot, api: TelegramApi, queue: UpdateQueue,
  options: { selfUrl: string; secret: string }, signal: AbortSignal, logger: Logger,
) {
  const path = WEBHOOK_PREFIX + bot.selfId
  const dispose = ctx.webuiServer.route(path, {
    async fetch(request) {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
      if (request.headers.get('x-telegram-bot-api-secret-token') !== options.secret) {
        return new Response('Forbidden', { status: 403 })
      }
      let update: Update
      try {
        update = await request.json()
      } catch {
        return new Response('Bad Request', { status: 400 })
      }
      if (typeof update?.update_id === 'number') queue.push(update)
      return new Response('OK')
    },
  }, { public: true })
  signal.addEventListener('abort', dispose, { once: true })

  const url = options.selfUrl.replace(/\/+$/, '') + path
  let failures = 0
  while (!signal.aborted) {
    try {
      await api.call('setWebhook', { url, secret_token: options.secret, allowed_updates: ALLOWED_UPDATES }, signal)
      bot.setStatus(Status.ONLINE)
      logger.info('Webhook 已设置为 %s', url)
      return
    } catch (e) {
      if (signal.aborted) return
      if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) {
        logger.error('Bot Token 无效: %s', e.description)
        bot.setStatus(Status.OFFLINE)
        return
      }
      failures++
      bot.setStatus(Status.RECONNECT)
      const delay = backoff(failures)
      logger.warn('设置 Webhook 失败: %s，%d 秒后重试', (e as Error).message, delay / 1000)
      await sleep(delay, signal)
    }
  }
}
