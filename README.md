# Telegram 协议

用 Bot Token 把 Telegram 机器人接入 LuckyLillia。它和「NTQQ 协议」「QQ 官方机器人」一样注册为中立层的 Bot（平台 `telegram`），所以：

- 插件的指令、`bot/message` 中间件不用改就能在 Telegram 的私聊、群组、超级群话题和频道里用；
- Satori 适配器会把它作为一个 `telegram` login 提供给外部客户端。

## 开始使用

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 创建机器人，得到 Token（形如 `123456789:AA...`）。
2. 在 WebUI「插件」里启用「Telegram」，填入 Token 保存。
3. **国内网络**需要代理：在「代理」插件里设置，或在本插件「网络 → 代理地址」里单独填写（`http://`、`socks5://`）。

一个插件条目对应一个机器人；要接多个机器人就添加多个条目。

### 群里收不到消息？

Telegram 机器人默认开着隐私模式，在群里只能收到 `/指令`、@ 它的消息和回复它的消息。要让机器人看到全部群消息，在 @BotFather 里 `/setprivacy` 选 Disable，然后把机器人移出群再重新拉进来；或者把它设为群管理员。

## 接收方式

| 方式 | 说明 |
|---|---|
| 长轮询（默认） | 主动向 Telegram 拉取，不需要公网地址 |
| Webhook | Telegram 推送到 `<公网地址>/telegram/webhook/<机器人 ID>`。需要 HTTPS 公网地址反向代理到 WebUI；请求用 `X-Telegram-Bot-Api-Secret-Token` 校验 |

切回长轮询时会自动删除之前设置的 Webhook。启动时跳过机器人离线期间积压的更新，避免回复过时的指令。

## ID 约定

Bot 方法和 Session 使用同一套 ID，原样传回即可：

| 对象 | ID |
|---|---|
| 私聊会话 | `private:<用户 ID>` |
| 群组、超级群、频道 | `<chat ID>`（负数），同时也是群（guild）ID |
| 论坛话题 | `<chat ID>/<话题 ID>`，所在群为 `<chat ID>` |
| 消息 | Telegram 的 message_id，只在同一会话内唯一 |
| 入群申请 | `<chat ID>@<用户 ID>`，传给 `handleGuildMemberRequest` |

用户的 `name` 是 @用户名（没有时为显示名），`nick` 是显示名。

## 消息

**发送**：文字和格式（粗体、斜体、下划线、删除线、剧透、代码、链接、引用块）以 Telegram HTML 发送；`at` 带 ID 时为可点的提及。图片、视频、语音、文件附带文字时作为说明文字；多张图片和视频合成相册（最多 10 个一组）。超长文字按行拆分。

- `markdown`、`card`、`face` 由宿主降级为格式文字后发送。
- 按钮：`link` 为链接按钮；`action` 为回调按钮，点击产生 `interaction/button`；指令按钮（默认类型）点击后，宿主会收到点击者发送的那条指令。
- 收到的图片等带有 `telegram-file-id`，原样发回时直接引用，不重新上传。

**接收**：文字的格式、@、`/指令@机器人名`（转为 `/指令`）、回复（`quote`）都会转换。图片、贴纸、动图、视频、语音、文件下载到插件数据目录，以 `file://` 地址给插件使用（不暴露 Token），超过设置大小（最多 20 MB，Bot API 的下载上限）时显示为 `[图片]` 之类的占位文字。动态贴纸（.tgs）显示为 `[贴纸 😀]`。相册的多条消息合并为一条。

**事件**：`message-created`、`message-updated`、`guild-added`/`guild-removed`（机器人进出群）、`guild-member-added`/`guild-member-removed`、`guild-member-request`、`reaction-added`/`reaction-removed`（机器人需为管理员）、`interaction/button`。每个更新另以 `internal` 事件提供原始数据，`_type` 为 `telegram/<更新类型>`，如 `telegram/message`。

## 管理方法

`sendMessage`、`sendPrivateMessage`、`deleteMessage`、`getUser`、`getGuild`、`getChannel`、`getChannelList`、`createDirectChannel`、`deleteChannel`（退群）、`getGuildMember`、`getGuildMemberList`（Telegram 只能列出管理员）、`kickGuildMember`、`muteGuildMember`、`muteChannel`、`handleGuildMemberRequest`、`createReaction`、`deleteReaction`、`updateCommands`。

Telegram 没有的能力（读历史消息、好友列表、机器人所在群列表）不提供对应方法。

插件指令会同步到 Telegram 的「/」菜单，只有名称为英文小写、数字和下划线的指令能进入菜单（中文指令照常可用，只是不出现在菜单里）。

### bot.internal

其它 Bot API 方法通过 `internal` 调用，方法名与官方文档一致，参数为一个对象：

```ts
import { internalOf } from '@luckylillia/plugin-sdk'
import type {} from '@luckylillia/plugin-telegram'

const tg = internalOf(session.bot, 'telegram')
await tg?.pinChatMessage({ chat_id: session.guildId, message_id: Number(session.messageId) })
```

## 开发

```sh
npm install
npm test        # 用本地模拟的 Bot API 测试，不需要真实 Token
npm run build
```

## 致谢

消息转换参考了 [Satori](https://github.com/satorijs/satori) 的 Telegram 适配器（`@satorijs/adapter-telegram`，即 Koishi 的 adapter-telegram），其 MIT 许可保存在 [licenses/satori-MIT.txt](licenses/satori-MIT.txt)。图标来源见 [assets/README.md](assets/README.md)。

## 许可

GPL-2.0
