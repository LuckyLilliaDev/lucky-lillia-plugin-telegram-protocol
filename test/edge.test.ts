import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h, type Bot, type Session, type WebUIServer } from '@luckylillia-dev/plugin-sdk'
import { createTestApp, type TestApp } from '@luckylillia-dev/plugin-sdk/testing'
import * as plugin from '../src/index.js'
import { TelegramApi, TelegramError } from '../src/api.js'
import { splitText } from '../src/encode.js'
import type { Message } from '../src/types.js'
import { BOT_ID, FakeApi, TOKEN } from './fakeApi.js'

const alice = { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' }
const group = { id: -100123, type: 'supergroup' as const, title: '测试群' }
const now = () => Math.floor(Date.now() / 1000)

function message(fields: Partial<Message>): Message {
  return { message_id: 7, date: now(), chat: group, from: alice, ...fields }
}

/** The text of Telegram HTML, as the user sees it */
function visible(html: string) {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/** Whether every tag opened is closed, in order */
function balanced(html: string) {
  const stack: string[] = []
  for (const [, slash, name] of html.matchAll(/<(\/?)([\w-]+)[^>]*>/g)) {
    if (!slash) stack.push(name)
    else if (stack.pop() !== name) return false
  }
  return stack.length === 0
}

describe('splitting long HTML', () => {
  it('closes and opens again a tag cut in two, never cuts inside an entity, and keeps all the text', () => {
    const html = '<b>' + 'a&amp;b '.repeat(40) + '</b>\n<i>' + 'x'.repeat(50) + '</i><a href="https://e.com/?q=1&amp;r=2">link</a>'
    const chunks = splitText(html, 64)
    expect(chunks.length).toBeGreaterThan(3)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(64)
      expect(balanced(chunk)).toBe(true)
      expect(chunk).not.toMatch(/&\w*$/)
    }
    expect(chunks.map(visible).join('').replace(/\n/g, '')).toBe(visible(html).replace(/\n/g, ''))
  })

  it('prefers to cut at a line end', () => {
    const chunks = splitText('<b>' + 'a'.repeat(30) + '\n' + 'b'.repeat(30) + '</b>', 50)
    expect(chunks).toEqual(['<b>' + 'a'.repeat(30) + '</b>', '<b>' + 'b'.repeat(30) + '</b>'])
  })

  it('ignores a closing tag it never saw opened', () => {
    const chunks = splitText('<b>x</i>' + 'y'.repeat(20) + '</b>', 16)
    for (const chunk of chunks) expect(chunk.startsWith('<b>')).toBe(true)
  })
})

describe('the API client', () => {
  let app: TestApp
  let api: FakeApi

  beforeEach(async () => {
    api = new FakeApi()
    await api.start()
    app = await createTestApp()
  })

  afterEach(async () => {
    await app.dispose()
    await api.stop()
  })

  it('waits out a 429 and tries again', async () => {
    let tries = 0
    api.handlers.sendMessage = () => {
      if (tries++ === 0) throw { code: 429, description: 'Too Many Requests: retry after 1', retryAfter: 1 }
      return { message_id: 1 }
    }
    const client = new TelegramApi(app.ctx.http, { token: TOKEN, endpoint: api.endpoint })
    const started = Date.now()
    expect(await client.call('sendMessage', { chat_id: 1, text: 'x' })).toEqual({ message_id: 1 })
    expect(tries).toBe(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('reports Telegram\'s errors with their code and description', async () => {
    api.handlers.sendMessage = () => { throw { code: 400, description: 'Bad Request: chat not found' } }
    const client = new TelegramApi(app.ctx.http, { token: TOKEN, endpoint: api.endpoint })
    const error = await client.call('sendMessage', {}).catch(e => e)
    expect(error).toBeInstanceOf(TelegramError)
    expect(error).toMatchObject({ code: 400, description: 'Bad Request: chat not found' })
  })

  it('keeps the token out of errors when the server cannot be reached', async () => {
    const client = new TelegramApi(app.ctx.http, { token: TOKEN, endpoint: 'http://127.0.0.1:1' })
    const error = await client.call('getMe').catch(e => e) as Error
    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain(TOKEN)
    expect(String(error.stack)).not.toContain(TOKEN)
  })
})

describe('the bot', () => {
  let app: TestApp
  let api: FakeApi

  beforeEach(async () => {
    api = new FakeApi()
    await api.start()
    app = await createTestApp()
    const server: WebUIServer = { route: () => () => {} }
    app.ctx.provide('webuiServer')
    app.ctx.set('webuiServer', server)
  })

  afterEach(async () => {
    await app.dispose()
    await api.stop()
  })

  async function load(config: Record<string, unknown> = {}) {
    await app.ctx.plugin(plugin, { token: TOKEN, endpoint: api.endpoint, pollingTimeout: 1, mediaMaxSize: 0, ...config })
    await api.waitFor('getWebhookInfo')
    return [...app.ctx.bots].find(b => b.platform === 'telegram')!
  }

  /** Every session of `type` from now on */
  function collect(type?: string) {
    const sessions: Session[] = []
    app.ctx.on('bot/session', (session) => {
      if (session.type === 'internal') return
      if (!type || session.type === type) sessions.push(session)
    })
    return sessions
  }

  async function until(check: () => boolean, timeout = 3000) {
    const deadline = Date.now() + timeout
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it('puts commands Telegram can take on its menu once online', async () => {
    app.ctx.command('hello', '打招呼').action(() => 'hi')
    app.ctx.command('签到', '每日签到').action(() => 'ok')
    await load()
    const [call] = await api.waitFor('setMyCommands', 1, 5000)
    expect(call.body.commands).toEqual([{ command: 'hello', description: '打招呼' }])
  })

  it('handles what came while it was away, but not messages older than five minutes', async () => {
    const sessions = collect('message-created')
    api.push({ message: message({ message_id: 1, text: 'stale', date: now() - 600 }) })
    api.push({ message: message({ message_id: 2, text: 'fresh', date: now() - 30 }) })
    await load()
    await until(() => sessions.length >= 1)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(sessions.map(s => s.content)).toEqual(['fresh'])
  })

  it('merges the messages of an album into one', async () => {
    await load()
    const sessions = collect('message-created')
    const photo = (id: string) => [{ file_id: id, file_unique_id: 'u' + id, width: 1, height: 1 }]
    api.push({ message: message({ message_id: 10, media_group_id: 'g1', caption: '两张', photo: photo('a') }) })
    api.push({ message: message({ message_id: 11, media_group_id: 'g1', photo: photo('b') }) })
    await until(() => sessions.length >= 1)
    await new Promise(resolve => setTimeout(resolve, 1300))
    expect(sessions).toHaveLength(1)
    expect(sessions[0].messageId).toBe('10')
    expect(sessions[0].content).toBe('两张 [图片][图片]')
  })

  it('makes edits message-updated', async () => {
    await load()
    const sessions = collect('message-updated')
    api.push({ edited_message: message({ text: 'fixed', edit_date: now() }) })
    await until(() => sessions.length >= 1)
    expect(sessions[0]).toMatchObject({ content: 'fixed', messageId: '7', guildId: '-100123' })
  })

  it('answers join requests by the id of their event', async () => {
    const bot = await load()
    const sessions = collect('guild-member-request')
    api.push({ chat_join_request: { chat: group, from: alice, user_chat_id: 42, date: now(), bio: '你好' } })
    await until(() => sessions.length >= 1)
    expect(sessions[0]).toMatchObject({ messageId: '-100123@42', userId: '42', guildId: '-100123' })
    await bot.handleGuildMemberRequest!(sessions[0].messageId!, true)
    const [call] = await api.waitFor('approveChatJoinRequest')
    expect(call.body).toEqual({ chat_id: '-100123', user_id: 42 })
  })

  it('mutes for a while, kicks without banning, and lifts a mute with the group\'s permissions', async () => {
    api.handlers.getChat = () => ({ ...group, permissions: { can_send_messages: true, can_send_photos: false } })
    const bot = await load()
    await bot.muteGuildMember!('-100123', '42', 60_000)
    const [mute] = await api.waitFor('restrictChatMember')
    expect(mute.body.permissions.can_send_messages).toBe(false)
    expect(mute.body.until_date).toBeGreaterThanOrEqual(now() + 55)
    expect(mute.body.until_date).toBeLessThanOrEqual(now() + 65)

    await bot.muteGuildMember!('-100123', '42', 0)
    const [, unmute] = await api.waitFor('restrictChatMember', 2)
    expect(unmute.body.permissions).toEqual({ can_send_messages: true, can_send_photos: false })
    expect(unmute.body.until_date).toBeUndefined()

    await bot.kickGuildMember!('-100123', '42')
    expect(api.calls.filter(c => c.method === 'banChatMember' || c.method === 'unbanChatMember').map(c => c.method))
      .toEqual(['banChatMember', 'unbanChatMember'])
  })

  it('uploads the file itself when a file id is not this bot\'s', async () => {
    const bot = await load()
    api.handlers.sendPhoto = (body) => {
      if (body.photo === 'OTHER') throw { code: 400, description: 'Bad Request: wrong file identifier' }
      return { message_id: 1, date: now(), chat: group }
    }
    const png = 'base64://' + Buffer.from('89504e47', 'hex').toString('base64')
    await bot.sendMessage('-100123', h('img', { src: png, telegramFileId: 'OTHER', telegramType: 'photo' }))
    const calls = await api.waitFor('sendPhoto', 2)
    expect(calls[0].body.photo).toBe('OTHER')
    expect(calls[1].body.photo).toBe('attach://file')
    expect(calls[1].body.file).toMatchObject({ size: 4 })
  })

  it('sends long text in pieces: the quote on the first, the buttons on the last', async () => {
    const bot = await load()
    const long = Array.from({ length: 600 }, (_, i) => `第 ${i} 行，一些文字`).join('\n')
    await bot.sendMessage('-100123', [h('quote', { id: '5' }), long, h('button', { type: 'link', href: 'https://e.com' }, '打开')])
    await until(() => api.calls.filter(c => c.method === 'sendMessage').length >= 2)
    const sends = api.calls.filter(c => c.method === 'sendMessage')
    for (const send of sends) expect(send.body.text.length).toBeLessThanOrEqual(4096)
    expect(sends[0].body.reply_parameters).toEqual({ message_id: 5, allow_sending_without_reply: true })
    expect(sends.slice(1).every(s => !s.body.reply_parameters)).toBe(true)
    expect(sends.at(-1)!.body.reply_markup.inline_keyboard[0][0]).toEqual({ text: '打开', url: 'https://e.com' })
    expect(sends.slice(0, -1).every(s => !s.body.reply_markup)).toBe(true)
  })

  it('makes a callback button click interaction/button', async () => {
    const bot = await load()
    await bot.sendMessage('private:42', ['投票', h('button', { type: 'action', id: 'vote:1' }, '赞成')])
    const [call] = await api.waitFor('sendMessage')
    expect(call.body.reply_markup.inline_keyboard[0][0]).toEqual({ text: '赞成', callback_data: 'vote:1' })
    const sessions = collect('interaction/button')
    api.push({ callback_query: { id: 'q2', from: alice, data: 'vote:1', message: message({ message_id: 9, chat: { id: 42, type: 'private', first_name: 'Alice' } }) } })
    await until(() => sessions.length >= 1)
    expect(sessions[0].event.button).toEqual({ id: 'vote:1' })
    expect(sessions[0].channelId).toBe('private:42')
    expect(sessions[0].isDirect).toBe(true)
  })

  it('mentions users by id, and sends each message of a forward on its own', async () => {
    const bot = await load()
    await bot.sendMessage('-100123', [h.at('42', { name: 'Alice' }), ' 你好'])
    await bot.sendMessage('-100123', h('message', { forward: true }, [h('message', {}, 'a'), h('message', {}, 'b')]))
    await until(() => api.calls.filter(c => c.method === 'sendMessage').length >= 3)
    const texts = api.calls.filter(c => c.method === 'sendMessage').map(c => c.body.text)
    expect(texts).toEqual(['<a href="tg://user?id=42">@Alice</a> 你好', 'a', 'b'])
  })

  it('stops polling when disposed', async () => {
    await load()
    await until(() => api.polls >= 2)
    await app.dispose()
    const polls = api.polls
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(api.polls).toBe(polls)
    // afterEach disposes again: make that harmless
    app = await createTestApp()
  })

  it('stays registered and keeps trying while Telegram cannot be reached', async () => {
    await app.ctx.plugin(plugin, { token: TOKEN, endpoint: 'http://127.0.0.1:1', pollingTimeout: 1 })
    const bot = [...app.ctx.bots].find((b: Bot) => b.platform === 'telegram')
    expect(bot?.sid).toBe(`telegram:${BOT_ID}`)
    await until(() => bot!.status === 4)
  })
})
