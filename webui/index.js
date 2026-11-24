// Plain ES module, no build step: React and the SDK come from the WebUI's import map.
import { createElement as h, useEffect, useId, useMemo, useState } from 'react'
import {
  Icon,
  SchemaForm,
  useBots,
  usePluginConfig,
  usePluginContext,
  usePlugins,
  usePluginStatus,
} from '@luckylillia-dev/plugin-sdk/webui'

export const name = '@luckylillia-dev/plugin-telegram-protocol'

const LINKS = [
  { label: '@BotFather', href: 'https://t.me/BotFather' },
  { label: '使用说明', href: 'https://github.com/LuckyLilliaDev/lucky-lillia-plugin-telegram-protocol#readme' },
]

const ADVANCED_FIELDS = ['endpoint', 'slash', 'mediaMaxSize', 'mediaCacheDays']

const stack = { display: 'grid', gap: 16, minWidth: 0 }
const sectionStack = { display: 'grid', gap: 14, minWidth: 0 }
const row = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }
const mutedStyle = { fontSize: 12, lineHeight: 1.6, margin: 0, overflowWrap: 'anywhere' }
const errorStyle = { fontSize: 12, lineHeight: 1.6, margin: 0, color: 'rgb(239 68 68)', overflowWrap: 'anywhere' }
const codeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  overflowWrap: 'anywhere',
}

const BADGE_STYLE = {
  green: { color: 'rgb(22 163 74)', background: 'rgba(34, 197, 94, 0.14)' },
  blue: { color: 'rgb(2 132 199)', background: 'rgba(14, 165, 233, 0.14)' },
  amber: { color: 'rgb(217 119 6)', background: 'rgba(245, 158, 11, 0.14)' },
  red: { color: 'rgb(220 38 38)', background: 'rgba(239, 68, 68, 0.14)' },
}

const STATUS_INFO = {
  1: { label: '在线', ...BADGE_STYLE.green },
  2: { label: '连接中', ...BADGE_STYLE.blue },
  3: { label: '断开中', ...BADGE_STYLE.amber },
  4: { label: '重连中', ...BADGE_STYLE.amber },
  0: { label: '离线', ...BADGE_STYLE.red },
}

function statusOf(status) {
  return STATUS_INFO[status] ?? STATUS_INFO[0]
}

function pill(label, palette) {
  return h('span', {
    style: {
      fontSize: 12,
      fontWeight: 500,
      padding: '3px 10px',
      borderRadius: 9999,
      flexShrink: 0,
      color: palette.color,
      background: palette.background,
    },
  }, label)
}

function Chevron({ open }) {
  return h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    style: {
      flexShrink: 0,
      transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
      transition: 'transform 0.18s ease',
    },
  }, h('path', { d: 'm6 9 6 6 6-6' }))
}

function botIdFromToken(token) {
  if (typeof token !== 'string') return ''
  const match = token.trim().match(/^(\d+):/)
  return match ? match[1] : ''
}

function formatBotIdentity(data) {
  const handle = data.username ? `@${data.username}` : data.name || data.id
  const details = []
  if (data.username && data.name && data.name !== data.username) details.push(data.name)
  details.push(`ID ${data.id}`)
  if (typeof data.latency === 'number') details.push(`耗时 ${data.latency} ms`)
  return `${handle}（${details.join('，')}）`
}

function describeProxyPlugin(plugins) {
  if (!plugins) {
    return {
      key: 'loading',
      badge: '检测中',
      palette: BADGE_STYLE.blue,
      text: '正在检测内置「代理」插件状态…',
      action: '',
    }
  }
  const entry = plugins.find(item => item.name === 'builtin:proxy')
  if (!entry || entry.disabled) {
    return {
      key: 'disabled',
      badge: '未启用',
      palette: BADGE_STYLE.amber,
      text: '未启用内置「代理」插件（当前为直连）。国内网络访问 Telegram 通常需要先启用并配置「代理」插件。',
      action: '去启用代理',
    }
  }
  if (entry.notice) {
    return {
      key: `notice:${entry.notice}`,
      badge: '待配置',
      palette: BADGE_STYLE.amber,
      text: `「代理」插件已启用，但尚未完成配置：${entry.notice}`,
      action: '去配置代理',
    }
  }
  if (entry.state === 'failed') {
    return {
      key: `failed:${entry.error ?? ''}`,
      badge: '异常',
      palette: BADGE_STYLE.red,
      text: `「代理」插件启动失败${entry.error ? `：${entry.error}` : ''}，请前往插件页检查。`,
      action: '去查看',
    }
  }
  if (entry.state !== 'active') {
    return {
      key: `state:${entry.state}`,
      badge: '启动中',
      palette: BADGE_STYLE.blue,
      text: '「代理」插件正在准备中，就绪后会自动接管 Telegram 请求。',
      action: '查看插件',
    }
  }
  return {
    key: 'active',
    badge: '已启用',
    palette: BADGE_STYLE.green,
    text: '已启用内置「代理」插件，Telegram 的登录、收发消息与媒体下载均自动通过它连接。',
    action: '代理设置',
  }
}

function ProxyStatusBanner({ proxyStatus }) {
  return h('div', {
    className: 'bg-theme-item rounded-xl',
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '12px 14px',
      flexWrap: 'wrap',
    },
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 260px', minWidth: 0 } },
    h('span', { className: 'text-sm font-medium text-theme', style: { flexShrink: 0 } }, '网络代理'),
    pill(proxyStatus.badge, proxyStatus.palette),
    h('span', { className: 'text-theme-secondary', style: mutedStyle }, proxyStatus.text),
  ),
  proxyStatus.action && h('a', {
    href: '#plugins',
    className: 'text-xs text-pink-500 hover:underline',
    style: { flexShrink: 0, fontWeight: 500 },
  }, proxyStatus.action))
}

function TelegramLogo({ size = 48 }) {
  const gradientId = useId()
  return h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 512 512',
    width: size,
    height: size,
    style: { display: 'block', flexShrink: 0, borderRadius: size >= 44 ? 12 : '9999px' },
    'aria-hidden': 'true',
  },
  h('defs', null,
    h('linearGradient', { id: gradientId, x1: '256', x2: '256', y1: '0', y2: '512', gradientUnits: 'userSpaceOnUse' },
      h('stop', { offset: '0', stopColor: '#38b0e3' }),
      h('stop', { offset: '1', stopColor: '#1d93d2' }),
    ),
  ),
  h('rect', { width: '512', height: '512', rx: '256', fill: `url(#${gradientId})` }),
  h('path', { d: 'm173.3 274.7 30.4 84.1s3.8 7.9 7.9 7.9 64.5-62.9 64.5-62.9l67.3-129.9-169 79.1z', fill: '#c8daea' }),
  h('path', { d: 'm213.6 296.3-5.8 62s-2.4 19 16.5 0c19-19 37.2-33.6 37.2-33.6', fill: '#a9c6d8' }),
  h('path', {
    d: 'm173.8 277.7-62.5-20.4s-7.5-3-5.1-9.9c.5-1.4 1.5-2.6 4.5-4.7C124.6 233.1 367 146 367 146s6.8-2.3 10.9-.8c2 .6 3.6 2.3 4 4.4.4 1.8.6 3.7.5 5.5 0 1.6-.2 3.1-.4 5.4-1.5 23.8-45.7 201.6-45.7 201.6s-2.6 10.4-12.1 10.8c-4.7.2-9.3-1.6-12.6-4.9-18.6-16-82.8-59.2-97-68.6-.6-.4-1.1-1.1-1.2-1.9-.2-1 .9-2.2.9-2.2s111.8-99.4 114.8-109.8c.2-.8-.6-1.2-1.8-.9-7.4 2.7-136.2 84.1-150.4 93-.9.2-2 .3-3.1.1',
    fill: '#ffffff',
  }))
}

function BotStatusCard({ bots }) {
  if (!bots.length) return null
  return h('div', { className: 'card', style: { padding: 20, display: 'grid', gap: 12 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('span', { className: 'text-sm font-semibold text-theme' }, '连接状态'),
      bots.length > 1 && h('span', { className: 'text-theme-muted', style: mutedStyle }, `${bots.length} 个机器人`),
    ),
    h('div', { style: { display: 'grid', gap: 10 } },
      bots.map((bot) => {
        const badge = statusOf(bot.status)
        const displayName = bot.name && bot.name !== bot.selfId ? bot.name : `机器人 ${bot.selfId}`
        return h('div', {
          key: bot.sid,
          className: 'bg-theme-item rounded-xl',
          style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', minWidth: 0 },
        },
        bot.avatar
          ? h('img', {
            src: bot.avatar,
            alt: displayName,
            style: { width: 40, height: 40, borderRadius: '9999px', objectFit: 'cover', flexShrink: 0 },
          })
          : h(TelegramLogo, { size: 40 }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', {
            className: 'text-sm font-medium text-theme',
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, displayName),
          h('div', { className: 'text-xs text-theme-muted', style: { marginTop: 2 } }, `ID: ${bot.selfId}`),
        ),
        pill(badge.label, badge))
      }),
    ),
    bots.length > 1 && h('p', { className: 'text-theme-muted', style: mutedStyle },
      '当前运行了多个 Telegram 机器人条目；下方配置对应第一个条目，其余条目请在「插件」页管理。'),
  )
}

function useConnectionTest(value, proxyKey, onTested) {
  const ctx = usePluginContext()
  const plugin = usePluginStatus()
  const available = !!plugin && !plugin.disabled && plugin.state === 'active'
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState(null)

  const token = value?.token ?? ''
  const endpoint = value?.endpoint ?? ''

  // Clear stale test results once token, endpoint, or global proxy status changes
  useEffect(() => {
    setResult(null)
    onTested?.(null)
  }, [token, endpoint, proxyKey])

  const testConnection = async () => {
    if (!value || testing || !available) return
    setTesting(true)
    setResult(null)
    try {
      const data = await ctx.api('/api/telegram/test', { method: 'POST', body: { config: value } })
      setResult({ ok: true, data })
      onTested?.(data)
      ctx.toast(`连接成功：${data.username ? `@${data.username}` : data.name || data.id}`)
    } catch (e) {
      const message = e instanceof Error ? e.message : '连接测试失败'
      setResult({ ok: false, message })
      onTested?.(null)
      ctx.toast(message, 'error')
    } finally {
      setTesting(false)
    }
  }

  return { available, testing, result, testConnection }
}

function TestResultNotice({ result }) {
  if (!result) return null
  if (!result.ok) return h('p', { role: 'alert', style: errorStyle }, result.message)
  return h('div', {
    role: 'status',
    'aria-live': 'polite',
    className: 'bg-theme-item rounded-xl',
    style: { padding: '10px 14px', display: 'grid', gap: 4 },
  },
  h('p', { style: { ...mutedStyle, color: 'rgb(22 163 74)', fontWeight: 500 } },
    `连接成功：${formatBotIdentity(result.data)}`),
  result.data?.canReadAllGroupMessages === false && h('p', { className: 'text-theme-muted', style: mutedStyle },
    '提示：该机器人已开启群组隐私模式，群内仅能收到 /指令、@ 和回复；如需接收全部群消息，请在 @BotFather 执行 /setprivacy → Disable 或将其设为群管理员。'))
}

function AdvancedSettings({ proxyStatus, formProps, hasAdvancedError }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (hasAdvancedError) setOpen(true)
  }, [hasAdvancedError])

  return h('section', {
    className: 'rounded-xl border border-theme-divider',
    style: { overflow: 'hidden', minWidth: 0 },
  },
  h('button', {
    type: 'button',
    'aria-expanded': open,
    onClick: () => setOpen(prev => !prev),
    className: 'text-theme hover:bg-theme-item',
    style: {
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '14px 18px',
      background: 'transparent',
      border: 0,
      cursor: 'pointer',
      textAlign: 'left',
    },
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 } },
    h('span', { className: 'text-sm font-semibold text-theme' }, '高级设置'),
    h('span', { className: 'text-theme-muted', style: mutedStyle }, '网络代理、Bot API 地址、指令菜单与媒体缓存'),
  ),
  h('span', { className: 'text-theme-muted', style: { display: 'inline-flex', alignItems: 'center' } },
    h(Chevron, { open }))),
  open && h('div', {
    className: 'border-t border-theme-divider',
    style: { padding: '18px 20px', display: 'grid', gap: 20, minWidth: 0 },
  },
  h('div', { style: sectionStack },
    h('h5', { className: 'text-xs font-semibold text-theme-secondary', style: { margin: 0 } }, '网络'),
    h(ProxyStatusBanner, { proxyStatus }),
    h(SchemaForm, formProps(['endpoint'])),
  ),
  h('div', {
    className: 'border-t border-theme-divider',
    style: { paddingTop: 18, ...sectionStack },
  },
  h('h5', { className: 'text-xs font-semibold text-theme-secondary', style: { margin: 0 } }, '消息'),
  h(SchemaForm, formProps(['slash', 'mediaMaxSize', 'mediaCacheDays'])))))
}

/**
 * Flattens an older cached `Schema.intersect` root into a `Schema.object` node so `SchemaForm`
 * always renders native form controls even before the Bot process reloads `lib/config.js`.
 */
export function normalizeObjectSchema(schema) {
  if (!schema?.refs) return schema
  const resolve = ref => (typeof ref === 'number' ? schema.refs[ref] : ref)
  const root = resolve(schema.uid)
  if (!root || root.type === 'object') return schema
  if (root.type !== 'intersect' || !Array.isArray(root.list)) return schema

  const refs = { ...schema.refs }
  const dict = {}
  const protocolOptions = []

  const collectObject = (node) => {
    if (!node || node.type !== 'object' || !node.dict) return
    for (const [key, ref] of Object.entries(node.dict)) {
      if (key === 'proxy') continue
      const field = resolve(ref)
      if (key === 'protocol' && field?.type === 'const') {
        protocolOptions.push(ref)
      } else {
        dict[key] = ref
      }
    }
  }

  for (const branchRef of root.list) {
    const branch = resolve(branchRef)
    if (!branch) continue
    if (branch.type === 'object') {
      collectObject(branch)
    } else if (branch.type === 'union' && Array.isArray(branch.list)) {
      for (const optionRef of branch.list) collectObject(resolve(optionRef))
    }
  }

  if (protocolOptions.length) {
    refs[-2] = {
      type: 'union',
      meta: { default: 'polling', description: '接收方式：选择从 Telegram 接收消息的方式' },
      list: protocolOptions,
    }
    dict.protocol = -2
  }

  refs[-1] = { type: 'object', meta: { default: {} }, dict }
  return { uid: -1, refs }
}

function TelegramFormBody({ schema, value, onChange, errors, onClearSecret, bots = [], proxyStatus, testedBotId }) {
  const objectSchema = useMemo(() => normalizeObjectSchema(schema), [schema])
  const protocol = value?.protocol === 'webhook' ? 'webhook' : 'polling'
  const selfUrl = value?.selfUrl ?? ''
  const hasAdvancedError = Boolean(errors && ADVANCED_FIELDS.some(field => errors[field]))

  const webhookBotId = botIdFromToken(value?.token)
    || testedBotId
    || (bots.length === 1 ? bots[0].selfId : '')
    || '<机器人 ID>'
  const webhookBase = selfUrl.trim().replace(/\/+$/, '') || 'https://bot.example.com'

  const formProps = fields => ({
    schema: objectSchema,
    value,
    onChange,
    errors,
    fields,
    ...(onClearSecret ? { onClearSecret } : {}),
  })

  return h('div', { style: { display: 'grid', gap: 18, minWidth: 0 } },
    h('div', { style: sectionStack },
      h(SchemaForm, formProps(['token', 'protocol'])),
      protocol === 'webhook'
        ? h('div', { style: sectionStack },
          h(SchemaForm, formProps(['selfUrl', 'secretToken'])),
          h('div', {
            className: 'bg-theme-item rounded-xl',
            style: { padding: '10px 14px', display: 'grid', gap: 4 },
          },
          h('span', { className: 'text-xs text-theme-muted' }, 'Webhook 接收地址'),
          h('code', { className: 'text-theme', style: codeStyle }, `${webhookBase}/telegram/webhook/${webhookBotId}`)),
        )
        : h(SchemaForm, formProps(['pollingTimeout'])),
    ),
    h(AdvancedSettings, { proxyStatus, formProps, hasAdvancedError }),
  )
}

/** Custom editor for the 插件 page config dialog, hiding irrelevant polling/webhook fields. */
function TelegramConfigEditor({ value, onChange, schema, errors }) {
  const bots = useBots()
  const plugins = usePlugins()
  const proxyStatus = useMemo(() => describeProxyPlugin(plugins), [plugins])
  const telegramBots = (bots ?? []).filter(bot => bot.platform === 'telegram')
  return h(TelegramFormBody, { schema, value, onChange, errors, bots: telegramBots, proxyStatus })
}

function TelegramSettings() {
  const config = usePluginConfig()
  const bots = useBots()
  const plugins = usePlugins()
  const proxyStatus = useMemo(() => describeProxyPlugin(plugins), [plugins])
  const telegramBots = (bots ?? []).filter(bot => bot.platform === 'telegram')
  const [testedBot, setTestedBot] = useState(null)
  const test = useConnectionTest(config.value, proxyStatus.key, setTestedBot)

  const onSubmit = (event) => {
    event.preventDefault()
    if (!config.value || config.saving) return
    void config.save()
  }

  return h('div', { style: stack },
    h(BotStatusCard, { bots: telegramBots }),
    h('form', { className: 'card', style: { padding: 24, display: 'grid', gap: 20 }, onSubmit },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' } },
        h(TelegramLogo, { size: 48 }),
        h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
          h('h3', { className: 'text-lg font-semibold text-theme', style: { margin: 0 } }, 'Telegram'),
          h('p', { className: 'text-sm text-theme-secondary', style: { margin: '4px 0 0' } },
            '用 Bot Token 接入 Telegram 机器人，插件和 Satori 客户端可以在私聊、群组、话题和频道里收发消息'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 } },
          LINKS.map(link => h('a', {
            key: link.href,
            href: link.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'text-sm text-pink-500 hover:underline',
            style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
          }, link.label)),
        ),
      ),
      config.error
        ? h('p', { role: 'alert', style: errorStyle }, `加载配置失败：${config.error}`)
        : !config.value
          ? h('p', { className: 'text-sm text-theme-muted', style: { margin: '12px 0' } }, '正在加载配置…')
          : h(TelegramFormBody, {
            schema: config.schema,
            value: config.value,
            onChange: config.setValue,
            errors: config.errors,
            onClearSecret: config.clearSecret,
            bots: telegramBots,
            proxyStatus,
            testedBotId: testedBot?.id,
          }),
      h(TestResultNotice, { result: test.result }),
      config.errors?.[''] && h('p', { role: 'alert', style: errorStyle }, config.errors['']),
      config.value && !config.error && h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' },
      },
      h('button', {
        type: 'button',
        onClick: test.testConnection,
        disabled: test.testing || config.saving || !test.available,
        title: test.available
          ? '用当前表单配置测试连通性（自动跟随全局「代理」插件），无需先保存'
          : '启用并加载本插件后可测试连接',
        className: 'btn-glass',
        style: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      },
      h(Icon, { name: 'send', size: 16 }),
      test.testing ? '正在测试连接…' : '测试连接'),
      h('button', {
        type: 'submit',
        disabled: config.saving,
        className: 'btn-primary',
      }, config.saving ? '保存中…' : '保存设置')),
    ),
  )
}

/** @type {import('@luckylillia-dev/plugin-sdk/webui').WebUIPlugin} */
export default function apply(ctx) {
  ctx.config(TelegramConfigEditor)
  ctx.page({
    id: 'telegram',
    title: 'Telegram',
    icon: 'send',
    component: TelegramSettings,
    order: 7,
    settings: true,
  })
}
