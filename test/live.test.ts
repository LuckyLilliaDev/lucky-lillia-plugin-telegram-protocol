/**
 * Against the real Bot API; skipped unless TG_LIVE=1. Through a proxy, let Node's fetch use it:
 *
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 TG_LIVE=1 npx vitest run test/live.test.ts
 *
 * With TG_TOKEN (a real bot's), it also logs in and polls; with TG_CHAT as well (a chat id the bot may write to,
 * e.g. your own user id after sending the bot /start), it sends a message there and deletes it again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h, type Bot, type WebUIServer } from '@luckylillia-dev/plugin-sdk'
import { createTestApp, type TestApp } from '@luckylillia-dev/plugin-sdk/testing'
import * as plugin from '../src/index.js'
import { TelegramApi, TelegramError } from '../src/api.js'

const live = process.env.TG_LIVE === '1'
const token = process.env.TG_TOKEN
const chat = process.env.TG_CHAT
const FAKE = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe.skipIf(!live)('the real Bot API', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await createTestApp()
    const server: WebUIServer = { route: () => () => {} }
    app.ctx.provide('webuiServer')
    app.ctx.set('webuiServer', server)
  })

  afterEach(() => app.dispose())

  it('answers a wrong token with 401, which fails the entry', async () => {
    const api = new TelegramApi(app.ctx.http, { token: FAKE, endpoint: 'https://api.telegram.org' })
    const error = await api.call('getMe').catch(e => e)
    expect(error).toBeInstanceOf(TelegramError)
    expect(error).toMatchObject({ code: 401 })
    await expect(app.ctx.plugin(plugin, { token: FAKE })).rejects.toThrow('Bot Token 无效')
  }, 30_000)

  it.skipIf(!token)('logs in and polls', async () => {
    await app.ctx.plugin(plugin, { token, slash: false, pollingTimeout: 5 })
    const bot = [...app.ctx.bots].find((b: Bot) => b.platform === 'telegram')!
    expect(bot.user?.name).toBeTruthy()
    const deadline = Date.now() + 20_000
    while (bot.status !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
    expect(bot.status).toBe(1)
  }, 30_000)

  it.skipIf(!token || !chat)('sends formatted text with a button, then deletes it', async () => {
    await app.ctx.plugin(plugin, { token, slash: false, pollingTimeout: 5 })
    const bot = [...app.ctx.bots].find((b: Bot) => b.platform === 'telegram')!
    const channel = Number(chat) > 0 ? `private:${chat}` : chat!
    const sent = await bot.sendMessage(channel, [
      h('b', {}, 'LuckyLillia 测试'), ' <&> ', h('i', {}, '斜体'), h('br'), h('code', {}, 'code'),
      h('button', { type: 'link', href: 'https://telegram.org' }, '链接'),
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0].id).toMatch(/^\d+$/)
    await bot.deleteMessage!(channel, sent[0].id)
  }, 30_000)
})
