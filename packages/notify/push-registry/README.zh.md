---
description: "Opt-in APNs push-notification registry: device-token registration over the authenticated Remote layer, sanitized title-level session-event notifications, a dedupe window with failure dominance, bounded retries, and a stdin-connected outbound command."
kind: "package-reference"
---

# @deepseek-ai/dsh-push-registry

[English](README.md) | 中文

<a id="summary"></a>
## 概述

通过现有鉴权 Remote 层登记 iOS 设备 token，并经由部署配置的出站命令向其投递标题级会话通知。服务只订阅 session-controller 已有的事件——`api-session/status`、`api-session/error` 与 `approval/request` waterfall——且在未配置出站命令前不会 spawn 任何进程。设备 token 只落盘，绝不进日志；投递记录不含 token。

## 目录

- [服务](#service)
- [事件与脱敏](#events-and-sanitization)
- [投递、去重与重试](#delivery-dedupe-and-retries)
- [存储布局](#storage-layout)
- [示例 APNs 脚本](#example-apns-script)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

`PushRegistry`（默认导出，Cordis 服务 `pushRegistry`）是 opt-in 的：默认组合不挂载它，添加它的组合自行选择登记目录与出站命令。鉴权来自现有连接层——Typert Gateway 只服务已认证连接，本包自身不做新的凭据校验。服务缺席时，`ctx.get('pushRegistry')` 读取返回 `undefined`。

| 方法 | 契约 |
|---|---|
| `register(req)` | 存储或刷新一条 `{ deviceId, platform, token }` 登记。只接受 `platform: 'ios'`；空 id 或空 token 即刻失败。重复登记同一设备 id 会替换其 token。token 只写入 `devices.json`，从不出现在日志或投递记录中。 |
| `unregister(req)` | 移除 `req.deviceId` 的登记，返回是否确有移除。 |
| `list()` | 返回全部登记的 `{ deviceId, platform, registeredAt }`；token 是秘密，视图一律省略。 |

| 配置字段 | 含义 |
|---|---|
| `registryDirectory` | 存放 `devices.json` 与 `deliveries.jsonl` 的绝对目录；构造时创建。必填。 |
| `outboundCommand` | 出站命令 argv。缺省 `undefined` 时只登记设备，从不 spawn 投递。 |
| `outboundTimeoutMs` | 单次尝试的出站截止时间；默认 15000。 |
| `dedupeWindowMs` | 同一会话同一类型事件只发一次通知的时间窗；默认 60000。 |
| `maxRetries` | 首次失败后的重试次数，指数退避；默认 2。 |

配置在构造时校验：相对登记目录、空 argv 或非整数预算都会让挂载失败，而不是让投递悄悄劣化。

<a id="events-and-sanitization"></a>
## 事件与脱敏

订阅集合是固定的；本包不把事件来源做成通用机制。

| 通知类型 | 来源事件 | 标题 |
|---|---|---|
| `turn-finished` | `api-session/status`（`running: false`） | `Turn finished` |
| `turn-failed` | `api-session/error` | `Turn failed` |
| `awaiting-confirmation` | `approval/request`（waterfall；监听者从不认领） | `Approval needed: <toolName>` |

`NotificationEvent` 只携带 `kind`、`sessionId`、`title` 与 `occurredAt`。session-controller 的错误消息被丢弃，因为错误链可能引用路径或消息内容；审批通知只写被询问的工具名——它是封闭工具目录中的标识符。消息正文、文件系统路径、工具参数永远到不了出站载荷。

<a id="delivery-dedupe-and-retries"></a>
## 投递、去重与重试

去重键是 `${sessionId}:${kind}`：窗口内一个会话的一种事件只发一次通知，投递失败会被记录，但不会超出配置的尝试预算之外重试。已记录的 `turn-failed` 在窗口内占优：同一失败回合配对的 `turn-finished` 被丢弃，失败的回合不会通知两次。除该占位关系外，各类型相互独立。

每次尝试 spawn `outboundCommand`，向 stdin 写入一行 JSON——`{ event, device: { deviceId, platform, token } }`——并在 `outboundTimeoutMs` 内期待退出码 0。命令运行在自己的进程组（detached spawn），因此超时 kill 能及于子进程而不会触及宿主的进程组。非零退出、spawn 失败与超时属于可重试失败；重试在首次失败后等待 250 ms，之后逐次翻倍。每个尝试预算都会在 `deliveries.jsonl` 落一条记录，含结果、尝试次数、耗时与简短失败原因（`exited with code N`、`timed out after N ms`）。

投递是 fire-and-forget：会话事件监听者把工作入队后立即返回，卸载时会等待在途的扇出完成再释放 fiber。

<a id="storage-layout"></a>
## 存储布局

`registryDirectory/devices.json` 存放登记文档。写入经 `writeFileAtomic` 并持有跨进程 `devices.json.lock` 写锁，读取者看到的是完整的新文档或完整的旧文档，文件权限为 0600。文档损坏或不可读时，下一次操作以 `RegistryStoreError` 即刻失败，绝不会被静默重置。`registryDirectory/deliveries.jsonl` 是追加型日志，绝不含 token。

<a id="example-apns-script"></a>
## 示例 APNs 脚本

`examples/apns-send.example.mjs` 是模板而非随包命令：它从环境变量读取 `.p8` 路径、key id、team id 与 bundle id，签一个 ES256 JWT，并用 `node:http2` 以 HTTP/2 POST（APNs provider API 只接受 HTTP/2）到 `api.push.apple.com`（`APNS_ENV=sandbox` 时为 `api.sandbox.push.apple.com`）。DER→raw 签名转换在可导入的 `examples/der-to-raw.mjs`，由 `examples/der-to-raw.test.mjs` 的固定向量单元测试锁定。该模板未对真实 APNs 端到端验证；生产前先用沙盒主机配真机实测。审阅它、把真实秘密配置在仓库之外，再把 `outboundCommand` 指向你的副本。测试使用一次性的 Node fixture 脚本。

<a id="model-experience"></a>
## Model Experience

None, as the service registers no model-facing tool, prompt, or event：通知保持标题级，只到达设备锁屏，从不进入模型请求或 Session 事件。

#### KV Cache effect

无。本服务不触碰提示、会话或请求路径，因此不影响 KV 缓存复用。

## Known Limitations and Deferred Work

- **与 M4 前事件模型的耦合** — 订阅依赖三个固定的 session-controller 事件。统一事件模型（M4）尚不存在，因此新的可通知场景需要修改本包；`api-session/status` 也无法区分回合结束与其他空闲转换。
- **审批请求是观察而非过滤** — 每次 `approval/request` waterfall 派发都会通知，包括应答者能立即解决的请求；监听者无法知道是否真有人会应答。自动应答的请求因此也会在去重窗口内产生通知。
- **对后台连接的依赖** — 手机没有可达的 `dsh web` 连接时，这条推送路径是此类通知唯一的到达手段，且它依赖事件发生的那一刻宿主在线。没有队列：宿主宕机期间发生的事件即告丢失。
- **Windows 投递没有进程组 kill** — 超时路径向 POSIX 进程组发信号；在 Windows 上组停止会让该次尝试即刻失败，而不是停止子进程。登记与只登记模式在各平台都可用。
- **无设备 token 生命周期** — 不消费 APNs feedback（失效或过期 token）；过期 token 会持续收到投递尝试，直到客户端注销。
- **单用户存储** — `devices.json` 是宿主用户名下的普通 0600 文件；除文件系统权限外无静态加密。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published：本包不暴露自己的运行时观察流，它拥有的 token 不进日志这一关系由聚焦行为测试覆盖。

</details>
