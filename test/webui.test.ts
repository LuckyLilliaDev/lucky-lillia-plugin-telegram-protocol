import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchHandler, WebUIServer } from '@luckylillia-dev/plugin-sdk'
import { createTestApp, type TestApp } from '@luckylillia-dev/plugin-sdk/testing'
import * as plugin from '../src/index.js'
import { TELEGRAM_API_PREFIX } from '../src/testRoute.js'
import { BOT_ID, FakeApi, TOKEN } from './fakeApi.js'

vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useEffect: () => {},
  useId: () => 'id-1',
  useMemo: (fn: () => unknown) => fn(),
  useState: (initial: unknown) => [initial, () => {}],
}))

vi.mock('@luckylillia-dev/plugin-sdk/webui', () => ({
  Icon: () => null,
  SchemaForm: () => null,
  useBots: () => [],
  usePluginConfig: () => ({ value: null, setValue: () => {}, schema: null, error: '', errors: {}, saving: false, save: async () => true, clearSecret: () => {} }),
  usePluginContext: () => ({}),
  usePlugins: () => [],
  usePluginStatus: () => ({ state: 'active', disabled: false }),
}))

describe('webui sidebar page module', () => {
  it('exposes a flat object Config schema without standalone proxy field', () => {
    const json = plugin.Config.toJSON() as { type?: string; dict?: Record<string, unknown>; uid?: number; refs?: Record<string, { type?: string; dict?: Record<string, unknown> }> }
    const root = json.refs && json.uid !== undefined ? json.refs[json.uid] : json
    expect(root.type).toBe('object')
    expect(Object.keys(root.dict ?? {})).toEqual([
      'token', 'protocol', 'pollingTimeout', 'selfUrl', 'secretToken',
      'endpoint', 'slash', 'mediaMaxSize', 'mediaCacheDays',
    ])
  })

  it('flattens a legacy intersect Config schema in the WebUI module without requiring a Bot restart', async () => {
    const { Schema } = await import('@luckylillia-dev/plugin-sdk')
    const legacy = Schema.intersect([
      Schema.object({ token: Schema.string().role('secret').default('') }),
      Schema.union([
        Schema.object({ protocol: Schema.const('polling').default('polling'), pollingTimeout: Schema.natural().default(30) }),
        Schema.object({ protocol: Schema.const('webhook').required(), selfUrl: Schema.string().default(''), secretToken: Schema.string().default('') }),
      ]),
      Schema.object({ proxy: Schema.string().default(''), endpoint: Schema.string().default('https://api.telegram.org') }),
    ]).toJSON()

    const mod = await import('../webui/index.js')
    const normalized = mod.normalizeObjectSchema(legacy)
    const root = normalized.refs[normalized.uid]
    expect(root.type).toBe('object')
    expect(Object.keys(root.dict)).toEqual(['token', 'pollingTimeout', 'selfUrl', 'secretToken', 'endpoint', 'protocol'])
    const protocol = normalized.refs[root.dict.protocol]
    expect(protocol.type).toBe('union')
    expect(protocol.list).toHaveLength(2)
  })

  it('registers a sidebar settings page and custom config editor matching package.json metadata', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.llbot.webui).toBe('webui/index.js')
    expect(pkg.files).toContain('webui')

    const mod = await import('../webui/index.js')
    expect(mod.name).toBe(pkg.name)

    const pages: Record<string, any>[] = []
    const editors: unknown[] = []
    mod.default({
      page(options: Record<string, any>) {
        pages.push(options)
        return () => {}
      },
      config(component: unknown) {
        editors.push(component)
        return () => {}
      },
    })

    expect(editors).toHaveLength(1)
    expect(typeof editors[0]).toBe('function')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      id: 'telegram',
      title: 'Telegram',
      icon: 'send',
      order: 7,
      settings: true,
    })
    expect(typeof pages[0].component).toBe('function')
  })
})

describe('connection test route', () => {
  let app: TestApp
  let api: FakeApi
  let routes: Map<string, { handler: FetchHandler; public?: boolean }>
  let mounts: number

  beforeEach(async () => {
    api = new FakeApi()
    await api.start()
    app = await createTestApp()
    routes = new Map()
    mounts = 0
    const server: WebUIServer = {
      route(prefix, handler, options) {
        mounts++
        routes.set(prefix, { handler, public: options?.public })
        return () => {
          if (routes.get(prefix)?.handler === handler) routes.delete(prefix)
        }
      },
    }
    app.ctx.provide('webuiServer')
    app.ctx.set('webuiServer', server)
  })

  afterEach(async () => {
    await app.dispose()
    await api.stop()
  })

  async function postTest(body?: unknown, path = `${TELEGRAM_API_PREFIX}/test`, method = 'POST') {
    const route = routes.get(TELEGRAM_API_PREFIX)
    expect(route).toBeDefined()
    expect(route!.public).toBe(false)
    const response = await route!.handler.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: response.status, json: await response.json() as any }
  }

  it('mounts before a token is saved and tests a draft token', async () => {
    api.handlers.getMe = () => ({
      id: BOT_ID,
      is_bot: true,
      first_name: 'Lillia',
      username: 'LilliaBot',
      can_join_groups: true,
      can_read_all_group_messages: false,
    })

    await app.ctx.plugin(plugin, { token: '' })
    const res = await postTest({ config: { token: TOKEN, endpoint: api.endpoint, proxy: '' } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      success: true,
      data: {
        id: String(BOT_ID),
        username: 'LilliaBot',
        name: 'Lillia',
        canJoinGroups: true,
        canReadAllGroupMessages: false,
      },
    })
    expect(typeof res.json.data.latency).toBe('number')
  })

  it('reuses the saved token when masked and blocks sending it to a changed endpoint origin', async () => {
    await app.ctx.plugin(plugin, { token: TOKEN, endpoint: api.endpoint, pollingTimeout: 1 })
    await api.waitFor('getWebhookInfo')

    const ok = await postTest({ config: { token: '********', endpoint: api.endpoint, proxy: 'direct' } })
    expect(ok.status).toBe(200)
    expect(ok.json.success).toBe(true)
    expect(ok.json.data.id).toBe(String(BOT_ID))

    const okTagged = await postTest({ config: { token: '********#1', endpoint: api.endpoint } })
    expect(okTagged.status).toBe(200)
    expect(okTagged.json.success).toBe(true)

    const changed = await postTest({ config: { token: '********', endpoint: 'https://evil.example.com' } })
    expect(changed.status).toBe(400)
    expect(changed.json.success).toBe(false)
    expect(changed.json.message).toContain('Bot API 地址已改变')
  })

  it('validates input, reports invalid tokens, and redacts tokens on network failure', async () => {
    await app.ctx.plugin(plugin, { token: '' })

    const empty = await postTest({ config: { token: '', endpoint: api.endpoint } })
    expect(empty.status).toBe(400)
    expect(empty.json.message).toContain('Bot Token')

    const badFormat = await postTest({ config: { token: 'not-a-token', endpoint: api.endpoint } })
    expect(badFormat.status).toBe(400)
    expect(badFormat.json.message).toContain('格式不对')

    const badUrl = await postTest({ config: { token: TOKEN, endpoint: 'ftp://example.com' } })
    expect(badUrl.status).toBe(400)
    expect(badUrl.json.message).toContain('Bot API 地址')

    api.handlers.getMe = () => { throw { code: 401, description: 'Unauthorized' } }
    const invalid = await postTest({ config: { token: TOKEN, endpoint: api.endpoint } })
    expect(invalid.status).toBe(400)
    expect(invalid.json.message).toContain('Bot Token 无效')

    const unreachable = await postTest({ config: { token: TOKEN, endpoint: 'http://127.0.0.1:1' } })
    expect(unreachable.status).toBe(502)
    expect(unreachable.json.success).toBe(false)
    expect(unreachable.json.message).not.toContain(TOKEN)

    const notFound = await postTest(undefined, `${TELEGRAM_API_PREFIX}/other`, 'POST')
    expect(notFound.status).toBe(404)

    const wrongMethod = await postTest(undefined, `${TELEGRAM_API_PREFIX}/test`, 'GET')
    expect(wrongMethod.status).toBe(405)
  })

  it('shares the route across multiple entries and hands off on disposal', async () => {
    const first = app.ctx.plugin(plugin, { token: '' })
    await first
    expect(mounts).toBe(1)

    const second = app.ctx.plugin(plugin, { token: TOKEN, endpoint: api.endpoint, pollingTimeout: 1 })
    await second
    await api.waitFor('getWebhookInfo')
    // Second entry reuses the existing route instead of double-mounting
    expect(mounts).toBe(1)

    await first.dispose()
    // Ownership transfers to the second entry
    expect(routes.has(TELEGRAM_API_PREFIX)).toBe(true)
    const res = await postTest({ config: { token: '********', endpoint: api.endpoint } })
    expect(res.status).toBe(200)
    expect(res.json.data.id).toBe(String(BOT_ID))

    await second.dispose()
    expect(routes.has(TELEGRAM_API_PREFIX)).toBe(false)
  })

  it('removes the route if plugin startup fails on an invalid token', async () => {
    api.handlers.getMe = () => { throw { code: 401, description: 'Unauthorized' } }
    await expect(app.ctx.plugin(plugin, { token: TOKEN, endpoint: api.endpoint })).rejects.toThrow('Bot Token 无效')
    expect(routes.has(TELEGRAM_API_PREFIX)).toBe(false)
  })
})
