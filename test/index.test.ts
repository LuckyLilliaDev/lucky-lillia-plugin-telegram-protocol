import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h, type Bot, type FetchHandler, type Session, type WebUIServer } from '@luckylillia/plugin-sdk'
import { createTestApp, type TestApp } from '@luckylillia/plugin-sdk/testing'
import * as plugin from '../src/index.js'
import { CommandButtons } from '../src/buttons.js'
import { decodeMessageEvents, decodeText } from '../src/decode.js'
import { escapeHtml, splitText } from '../src/encode.js'
import { parseChannel } from '../src/ids.js'
import type { Message } from '../src/types.js'
import { BOT_ID, FakeApi, TOKEN } from './fakeApi.js'

const ctx = { selfId: String(BOT_ID), username: 'LilliaBot' }
const alice = { id: 42, is_bot: false, first_name: 'Alice', last_name: 'Liddell', username: 'alice' }
const group = { id: -100123, type: 'supergroup' as const, title: '测试群' }

function message(fields: Partial<Message>): Message {
  return { message_id: 7, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: 'private', first_name: 'Alice' }, from: alice, ...fields }
}

describe('decoding', () => {
  it('turns entities into elements, the bot\'s @ and /command@bot included', () => {
    const text = '@LilliaBot /start@LilliaBot bold link'
    const elements = decodeText(text, [
      { type: 'mention', offset: 0, length: 10 },
      { type: 'bot_command', offset: 11, length: 16 },
      { type: 'bold', offset: 28, length: 4 },
      { type: 'text_link', offset: 33, length: 4, url: 'https://example.com' },
    ], ctx)
    expect(elements.join('')).toBe(`<at id="${BOT_ID}" name="LilliaBot"/> /start <b>bold</b> <a href="https://example.com">link</a>`)
  })

  it('leaves another bot\'s command and @ as text', () => {
    const elements = decodeText('/start@OtherBot @someone', [
      { type: 'bot_command', offset: 0, length: 15 },
      { type: 'mention', offset: 16, length: 8 },
    ], ctx)
    expect(elements.join('')).toBe('/start@OtherBot @someone')
  })

  it('puts private chats, groups and forum topics in their channels', async () => {
    const [direct] = await decodeMessageEvents(message({ text: 'hi' }), 'message-created', ctx)
    expect(direct.channel).toEqual({ id: 'private:42', type: 1, name: undefined })
    expect(direct.guild).toBeUndefined()
    expect(direct.user).toEqual({ id: '42', name: 'alice', nick: 'Alice Liddell', is_bot: false })

    const [inGroup] = await decodeMessageEvents(message({ chat: group, text: 'hi' }), 'message-created', ctx)
    expect(inGroup.channel?.id).toBe('-100123')
    expect(inGroup.guild).toEqual({ id: '-100123', name: '测试群' })

    const [inTopic] = await decodeMessageEvents(message({
      chat: { ...group, is_forum: true }, text: 'hi', is_topic_message: true, message_thread_id: 5,
      reply_to_message: message({ message_id: 5, chat: group, forum_topic_created: { name: 't' } }),
    }), 'message-created', ctx)
    expect(inTopic.channel?.id).toBe('-100123/5')
    expect(inTopic.guild?.id).toBe('-100123')
    // Replying in a topic is no quote
    expect(inTopic.message?.quote).toBeUndefined()
    expect(parseChannel('-100123/5')).toEqual({ chat_id: '-100123', message_thread_id: 5 })
    expect(parseChannel('private:42')).toEqual({ chat_id: '42' })
  })

  it('quotes what a message replies to', async () => {
    const [event] = await decodeMessageEvents(message({
      chat: group, text: 'yes', reply_to_message: message({ message_id: 3, chat: group, text: 'really?' }),
    }), 'message-created', ctx)
    expect(event.message?.content).toBe('<quote id="3"/>yes')
    expect(event.message?.quote).toMatchObject({ id: '3', content: 'really?', user: { id: '42' } })
  })

  it('makes members joining and leaving events of their own', async () => {
    const bob = { id: 43, is_bot: false, first_name: 'Bob' }
    const events = await decodeMessageEvents(message({ chat: group, new_chat_members: [bob] }), 'message-created', ctx)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'guild-member-added', guild: { id: '-100123' }, user: { id: '43', name: 'Bob' } })
  })

  it('shows files it does not download as placeholders', async () => {
    const [event] = await decodeMessageEvents(message({
      caption: 'look', photo: [{ file_id: 'a', file_unique_id: 'ua', width: 10, height: 10 }],
    }), 'message-created', ctx)
    expect(event.message?.content).toBe('look [图片]')
  })
})

describe('encoding helpers', () => {
  it('escapes text for Telegram HTML', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;')
  })

  it('splits long text at line ends', () => {
    const chunks = splitText('a'.repeat(6) + '\n' + 'b'.repeat(6), 10)
    expect(chunks).toEqual(['aaaaaa', 'bbbbbb'])
  })

  it('keeps command button texts in 64 bytes of callback data', () => {
    const buttons = new CommandButtons()
    expect(buttons.decode(buttons.encode('/sign'))).toBe('/sign')
    const long = '/查询 '.repeat(20)
    const data = buttons.encode(long)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(buttons.decode(data)).toBe(long)
    expect(buttons.isCommand('custom-action')).toBe(false)
  })
})

describe('the plugin', () => {
  let app: TestApp
  let api: FakeApi
  /** What the plugin served through the stand-in webuiServer */
  let routes: Map<string, { handler: FetchHandler; public?: boolean }>

  beforeEach(async () => {
    api = new FakeApi()
    await api.start()
    app = await createTestApp()
    routes = new Map()
    const server: WebUIServer = {
      route(prefix, handler, options) {
        routes.set(prefix, { handler, public: options?.public })
        return () => routes.delete(prefix)
      },
    }
    app.ctx.provide('webuiServer')
    app.ctx.set('webuiServer', server)
  })

  afterEach(async () => {
    await app.dispose()
    await api.stop()
  })

  async function load(config: Record<string, unknown> = {}) {
    await app.ctx.plugin(plugin, { token: TOKEN, endpoint: api.endpoint, pollingTimeout: 1, mediaMaxSize: 20, ...config })
    // Logged in and polling
    await api.waitFor('getWebhookInfo')
    const bot = [...app.ctx.bots].find(b => b.platform === 'telegram')!
    expect(bot).toBeDefined()
    return bot
  }

  function next(event: 'bot/message' | 'bot/event' = 'bot/message') {
    return new Promise<Session>((resolve) => {
      if (event === 'bot/message') {
        app.ctx.on('bot/message', (session, nextFn) => { resolve(session); return nextFn() })
      } else {
        app.ctx.on('bot/event', session => { if (session.type !== 'internal') resolve(session) })
      }
    })
  }

  it('logs in, receives a message and replies in HTML, quoting it', async () => {
    const bot = await load()
    expect(bot.sid).toBe(`telegram:${BOT_ID}`)
    expect(bot.user?.name).toBe('LilliaBot')
    app.ctx.on('bot/message', async (session, nextFn) => {
      if (session.stripped.content !== 'ping') return nextFn()
      await session.reply(h('b', {}, 'pong <1>'))
    })
    api.push({ message: message({ chat: group, text: '@LilliaBot ping', entities: [{ type: 'mention', offset: 0, length: 10 }] }) })
    const [call] = await api.waitFor('sendMessage')
    expect(call.body).toMatchObject({
      chat_id: '-100123',
      text: '<b>pong &lt;1&gt;</b>',
      parse_mode: 'HTML',
      reply_parameters: { message_id: 7 },
    })
  })

  it('sends a picture with its caption, and markdown as formatted text', async () => {
    const bot = await load()
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    const sent = await bot.sendMessage('private:42', ['看图', h.image('base64://' + png)])
    const [photo] = await api.waitFor('sendPhoto')
    expect(photo.body).toMatchObject({ chat_id: '42', caption: '看图', parse_mode: 'HTML', photo: 'attach://file' })
    expect(photo.body.file).toMatchObject({ size: 8 })
    expect(sent).toHaveLength(1)

    await bot.sendMessage('-100123/5', h('markdown', {}, '**粗体**'))
    const [text] = await api.waitFor('sendMessage')
    expect(text.body).toMatchObject({ chat_id: '-100123', message_thread_id: 5 })
    expect(text.body.text).toContain('<b>粗体</b>')
  })

  it('sends several pictures as an album', async () => {
    const bot = await load()
    const png = 'base64://' + Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    const sent = await bot.sendMessage('-100123', ['两张', h.image(png), h.image(png)])
    const [album] = await api.waitFor('sendMediaGroup')
    const media = JSON.parse(album.body.media)
    expect(media).toEqual([
      { type: 'photo', media: 'attach://file0', caption: '两张', parse_mode: 'HTML' },
      { type: 'photo', media: 'attach://file1' },
    ])
    expect(sent).toHaveLength(2)
  })

  it('turns a command button click into a message from whoever clicked', async () => {
    const bot = await load()
    await bot.sendMessage('-100123', ['选一个', h('button', { text: '/sign' }, '签到')])
    const [call] = await api.waitFor('sendMessage')
    const data = call.body.reply_markup.inline_keyboard[0][0].callback_data
    expect(call.body.reply_markup.inline_keyboard[0][0].text).toBe('签到')

    const received = next()
    api.push({ callback_query: { id: 'q1', from: alice, data, message: message({ message_id: 9, chat: group, text: '选一个' }) } })
    const session = await received
    expect(session.content).toBe('/sign')
    expect(session.userId).toBe('42')
    expect(session.channelId).toBe('-100123')
    expect((await api.waitFor('answerCallbackQuery'))[0].body.callback_query_id).toBe('q1')
  })

  it('downloads received pictures for plugins, and sends them back by file id', async () => {
    api.handlers.getFile = body => ({ file_id: body.file_id, file_unique_id: 'u1', file_path: 'photos/a.jpg' })
    api.files['photos/a.jpg'] = Buffer.from('jpeg-bytes')
    const bot = await load()
    const received = next()
    api.push({ message: message({ photo: [{ file_id: 'F1', file_unique_id: 'u1', width: 1, height: 1, file_size: 10 }] }) })
    const session = await received
    const [img] = session.elements
    expect(img.type).toBe('img')
    expect(String(img.attrs.src)).toMatch(/^file:\/\/.*u1\.jpg$/)
    expect(img.attrs.telegramFileId).toBe('F1')

    await bot.sendMessage(session.channelId!, session.elements)
    const [photo] = await api.waitFor('sendPhoto')
    expect(photo.body.photo).toBe('F1')
  })

  it('takes updates by webhook, checking Telegram\'s secret', async () => {
    await app.ctx.plugin(plugin, {
      token: TOKEN, endpoint: api.endpoint, protocol: 'webhook', selfUrl: 'https://bot.example.com/', secretToken: 's3cret',
    })
    const [set] = await api.waitFor('setWebhook')
    expect(set.body).toMatchObject({ url: `https://bot.example.com/telegram/webhook/${BOT_ID}`, secret_token: 's3cret' })
    const route = routes.get(`/telegram/webhook/${BOT_ID}`)!
    expect(route.public).toBe(true)

    const post = (secret: string) => route.handler.fetch(new Request(`http://localhost/telegram/webhook/${BOT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({ update_id: 1, message: message({ text: 'hello' }) }),
    }))
    expect((await post('wrong')).status).toBe(403)
    const received = next()
    expect((await post('s3cret')).status).toBe(200)
    expect((await received).content).toBe('hello')
  })

  it('waits for a token instead of failing, and fails on a wrong one', async () => {
    await app.ctx.plugin(plugin, { token: '' })
    expect([...app.ctx.bots].some((b: Bot) => b.platform === 'telegram')).toBe(false)

    api.handlers.getMe = () => { throw { code: 401, description: 'Unauthorized' } }
    let error: unknown
    try {
      await app.ctx.plugin(plugin, { token: TOKEN, endpoint: api.endpoint })
    } catch (e) {
      error = e
    }
    expect(String(error)).toContain('Bot Token 无效')
  })
})
