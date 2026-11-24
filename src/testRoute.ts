import type { Context, WebUIServer } from '@luckylillia-dev/plugin-sdk'
import { TelegramApi, TelegramError } from './api.js'
import { DEFAULT_ENDPOINT, TOKEN_PATTERN, type Config } from './config.js'
import { fullName } from './ids.js'
import type { User } from './types.js'

export const TELEGRAM_API_PREFIX = '/api/telegram'

const TEST_TIMEOUT = 15_000
const SECRET_MASK = /^\*{8}(?:#.*)?$/

interface RouteEntry {
  ctx: Context
  storedConfig: () => Config
}

interface RouteRegistry {
  entries: Map<symbol, RouteEntry>
  owner?: symbol
  dispose?: () => void
}

const registries = new WeakMap<WebUIServer, RouteRegistry>()

/**
 * Registers the private `/api/telegram/test` route shared across entries of this plugin on the same WebUI server.
 * Disposing the route owner hands it off to the next live entry until the last one unloads.
 */
export function registerTestRoute(ctx: Context, storedConfig: () => Config) {
  const server = ctx.webuiServer
  let registry = registries.get(server)
  if (!registry) {
    registry = { entries: new Map() }
    registries.set(server, registry)
  }
  const id = Symbol('telegram-entry')
  registry.entries.set(id, { ctx, storedConfig })
  if (!registry.owner) mount(server, registry, id)

  ctx.effect(() => () => {
    registry.entries.delete(id)
    if (registry.owner !== id) return
    registry.dispose?.()
    registry.owner = undefined
    registry.dispose = undefined
    const next = registry.entries.keys().next()
    if (!next.done) mount(server, registry, next.value)
    else registries.delete(server)
  })
}

function mount(server: WebUIServer, registry: RouteRegistry, owner: symbol) {
  registry.owner = owner
  registry.dispose = server.route(TELEGRAM_API_PREFIX, {
    fetch: request => handleApiRequest(registry, request),
  }, { public: false })
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function redactToken(message: string, token: string): string {
  return token && message.includes(token) ? message.split(token).join('<token>') : message
}

async function handleApiRequest(registry: RouteRegistry, request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (pathname !== `${TELEGRAM_API_PREFIX}/test`) {
    return Response.json({ success: false, message: 'Not Found' }, { status: 404 })
  }
  if (request.method !== 'POST') {
    return Response.json({ success: false, message: 'Method Not Allowed' }, { status: 405 })
  }

  const primary = registry.entries.values().next().value
  if (!primary) {
    return Response.json({ success: false, message: 'Telegram 插件未就绪' }, { status: 503 })
  }

  const body = await request.json().catch(() => undefined) as { config?: unknown } | undefined
  if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) {
    return Response.json({ success: false, message: '请求参数格式不正确' }, { status: 400 })
  }

  const saved = primary.storedConfig()
  const raw = (body?.config && typeof body.config === 'object' && !Array.isArray(body.config)
    ? body.config
    : saved) as Record<string, unknown>

  const endpointInput = typeof raw.endpoint === 'string' && raw.endpoint.trim()
    ? raw.endpoint.trim()
    : DEFAULT_ENDPOINT
  const endpointUrl = parseHttpUrl(endpointInput)
  if (!endpointUrl) {
    return Response.json({ success: false, message: 'Bot API 地址格式不正确，需要 http:// 或 https:// 开头' }, { status: 400 })
  }

  const draftToken = typeof raw.token === 'string' ? raw.token.trim() : ''
  let token = draftToken
  if (SECRET_MASK.test(draftToken)) {
    const savedToken = saved.token.trim()
    if (!savedToken) {
      return Response.json({ success: false, message: '未找到已保存的 Bot Token，请重新填写后再测试' }, { status: 400 })
    }
    const savedEndpointUrl = parseHttpUrl(saved.endpoint.trim() || DEFAULT_ENDPOINT)
    if (!savedEndpointUrl || savedEndpointUrl.origin !== endpointUrl.origin) {
      return Response.json({ success: false, message: 'Bot API 地址已改变，请重新填写 Bot Token 后再测试' }, { status: 400 })
    }
    token = savedToken
  }

  if (!token) {
    return Response.json({ success: false, message: '请先填写 Bot Token' }, { status: 400 })
  }
  if (!TOKEN_PATTERN.test(token)) {
    return Response.json({ success: false, message: 'Bot Token 格式不对，应形如 123456789:AAxxxx（从 @BotFather 获得）' }, { status: 400 })
  }

  // Uses ctx.http directly so the builtin「代理」plugin applies automatically when enabled
  const http = primary.ctx.http.extend({ timeout: TEST_TIMEOUT })
  const api = new TelegramApi(http, { token, endpoint: endpointInput })
  const started = Date.now()
  try {
    const me = await api.call<User>('getMe', undefined, AbortSignal.timeout(TEST_TIMEOUT))
    return Response.json({
      success: true,
      data: {
        id: String(me.id),
        username: me.username ?? '',
        name: fullName(me),
        canJoinGroups: me.can_join_groups,
        canReadAllGroupMessages: me.can_read_all_group_messages,
        latency: Date.now() - started,
      },
    })
  } catch (e) {
    if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) {
      return Response.json({ success: false, message: 'Bot Token 无效，请到 @BotFather 核对' }, { status: 400 })
    }
    if (e instanceof TelegramError) {
      return Response.json({ success: false, message: redactToken(e.message, token) }, { status: 502 })
    }
    const reason = redactToken(e instanceof Error ? e.message : String(e), token)
    return Response.json({ success: false, message: `连接 Telegram 失败：${reason}（国内网络请检查「代理」插件是否已启用并配置）` }, { status: 502 })
  }
}
