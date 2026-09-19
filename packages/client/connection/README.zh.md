---
description: "Web GUI 的浏览器与 Host 之间的协议层：Remote RPC、带重连的事件流投递、精确 Fetch 路由、/api HTTP 桥与浏览器信任栅栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载浏览器到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation。Client 插件挂载 `ctx.connection`，其中包含当前页面的 loopback 状态、通用 RPC、当前 generation 及其 Host 信息、可观察的恢复状态、立即重连命令，以及单一 generation source 的注册点。source 报告 ready 后 generation 才可见；source 结束、失败、被撤回或显式 stop 都会清空它，再由 `ConnectionController` 执行重试策略。

## 目录

- [使用本包](#use-this-package)
- [浏览器认证与请求信任](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

静态桌面页面可以通过 `__DSH_TRANSPORT__.streamBaseUrl` 提供其所拥有 Host 的 HTTP origin。Gateway 将该 origin 用于 WebSocket，HTTP 传输仍独立选择。桌面载体负责认证；仅设置 origin 不会授予访问权限。

浏览器通过 HTTP POST 执行 Remote 一元调用；API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。由 shell 持有的组合通过 `connection.rpc.open` 提供等价的 Remote 流，不打开 WebSocket。浏览器插件读取页面 transport、恢复设置与 location，再委托 `installConnection(ctx, options)`。持有自身载体的组合可以直接调用同一个安装函数；整机客户端测试档就是这一消费者。每次调用都会创建一个归所属 Context 的服务，因此同一 realm 中的多棵 Client 树可以使用不同载体。Host half 始终提供与载体无关的 RPC 注册表和精确 `GET`/`HEAD`/`POST` 路由注册表。存在 Web 载体时，它还持有唯一 `/api` route、Fetch bridge、浏览器认证与 Host/Origin 校验；由 shell 持有的载体则直接分派共享 Fetch handler。每条精确路由会在 bridge 读取任何字节前声明缓冲或流式请求体处理方式。Typert Gateway 认领生成的 Remote endpoint，功能包注册 Session 日志下载、原始文件上传等非 JSON 响应，未认领的请求返回 404。Loopback hostname 判定只供浏览器侧当前页面状态使用，留在包内。浏览器原始请求体传输由 [`dsh-client-file-upload`](../file-upload/README.zh.md) 提供。

-----

<a id="browser-authentication-and-request-trust"></a>
## 浏览器认证与请求信任

每个 Host RPC 方法和 WebSocket 流都要求一个浏览器会话，不存在按方法区分的 loopback 层。每个进程生成一个随机启动令牌。`dsh-web-app` 打印并打开带 `?token=...` 的普通根 URL；`frontend-static` 把根路径和 index 请求交给 `ctx.connection.authorizeIndex`，后者只在 `GET /` 接受该令牌，先登记一个服务端会话，再写入命名该会话、绑定 authority 的签名 cookie，然后重定向到干净的 `/`。缺失、过期、畸形或 authority 不匹配的 cookie 会在 RPC 分发前得到 401。静态资源保持公开。HTTP 载体不在根路径交换之外接受 query token，也不接受 Authorization header token。

cookie 签名密钥是 `ctx.credentials` 中由 `client-connection/browser-session` 拥有的 grant 记录，会话登记把它的 JSON 快照作为 `client-connection/browser-sessions` 记录存在同一旁；本地提供方把两者都持久化到 `$DSH_HOME/.credentials.yaml`，Connection 激活期间把两者都载入内存，因此请求认证同步执行。每次令牌交换都先登记会话再铸造命名它的 cookie，而校验还要求该会话存在且未被撤销，因此撤销一条登记会让对应 cookie 失效，且不触碰签名密钥。删除或替换记录会在下一次 Connection 激活时生效。cookie 携带绝对签发与过期区间，`cookieMaxAgeDays` 默认设为 30 天，并在确定性名称与签名 payload 中同时绑定规范化 hostname 和 port。它是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`。随附服务器使用 loopback HTTP，因此 `Secure` 默认关闭；仅当浏览器 origin 经 HTTPS 终止的反向代理提供时，才把 Host Connection 行的 `cookieSecure` 设为 true，这同时把铸造的配对 URL 切换为 `https`。

Connection 自有五条需认证的会话生命周期 Fetch 路由：`GET /api/connection.sessions` 列出登记（设备标签、绑定的证书序列号（如有）与签发、过期、撤销时间，绝无 cookie 值或证书本体）；`POST /api/connection.sessions.revoke` 携带 `{ sessionId }` 撤销一条登记；`POST /api/connection.certificates.revoke` 携带 `{ serial }` 撤销绑定同一证书序列号的全部登记；`POST /api/connection.logout` 撤销调用方自己的会话并令其 cookie 过期；`POST /api/connection.pairing.mint` 携带 `{ ttlMs?, deviceLabel }` 铸造一枚一次性配对令牌，并返回带 `?token=...` 的普通根 URL。配对令牌是 32 字节随机 base64url 密文，同时未消费的至多 5 枚，有效期至多 10 分钟（默认 5 分钟）；`authorizeIndex` 只消费它一次，按铸造时的设备标签登记会话并签发该会话的 cookie。令牌只保存在内存中，不写日志，也不出现在错误消息里。同一认证检查同样把守 `/api/remote.mux` 的 WebSocket 升级，因此被撤销的会话在下次握手时会被拒绝；API Gateway 还会以 WebSocket close code 4401（`session revoked`）关闭该会话已被接受的 mux 连接——语义见 [Gateway README](../../api/gateway/README.zh.md#revocation-disconnects-accepted-mux-connections)。

当部署在 DSH 前面用 Caddy 终止每设备 mTLS 时，会话可以绑定打开它的那台设备的客户端证书。Caddy 用离线设备 CA 校验证书并转发其序列号；DSH 不接触 TLS 握手，只把受信代理传来的序列号头当作采信来源。把 Host Connection 行的 `mtlsClientSerialHeader` 设为该头——`header_up X-DSH-Client-Serial {http.request.tls.client.serial}`——并把 `mtlsTrustedProxies` 设为该代理的远端 socket 地址，Caddy 经本机回环反代时即为 `127.0.0.1`。默认（不配置该头）从不读取序列号头，保持原有仅 cookie 的行为；配置了头却没有受信代理条目会让插件加载失败。DSH 接受 Caddy 的十进制渲染或十六进制，并归一化为小写十六进制后存储。每次令牌交换（进程启动令牌与配对令牌）都把受信序列号绑定到新登记，被绑定的会话只接受受信代理转发相同序列号的请求，因此复制到其他设备上的 cookie 对不再有效。绑定的会话一旦请求中没有受信代理提供的序列号（代理未带头、对端不在列表内、或事后从配置中移除该字段）就会被拒绝，绝不静默退回仅 cookie 模式。撤销按登记或按设备执行：`sessions.revoke` 与 `logout` 各自撤销一条会话，而 `certificates.revoke` 同时作废该序列号及其绑定的全部会话。

认证之前，每个请求仍经过 `src/api-request-trust.ts`。其 `Host` 必须是 loopback，或与 `trustedHosts` 条目匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化。若附带 `Origin`，它必须等于该 Host；`sec-fetch-site: cross-site` 一律拒绝。畸形配置 authority 会让插件加载失败。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败返回 403；Host 可信但未认证的请求返回 401。`dsh web --host 0.0.0.0` 仍不受支持。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)与[浏览器令牌认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)。

通过认证的共享 HTTP 请求在传输请求体之前经过 `connection/request` waterfall。监听器可以拒绝新请求，或等待 `next()` 直到响应完成；释放所属 fiber 会移除准入行为。Desktop 使用此扩展点，在已批准的安装期间锁住新的 API 工作，而不取消已接纳的工作。WebSocket 流仍由 API Gateway 负责。

Connection 分发的每个请求——精确 Fetch 路由与共享通道 RPC 拦截器——都在 `ctx.connection.caller.run(callerOf(request), ...)` 内执行：这是一个 AsyncLocalStorage 作用域，保存该请求的调用方身份，包括小写并带端口的 `Host` 头、该头是否为 loopback 主机，以及已验证 cookie 的 `sessionId` 与绑定的 `certificateSerial`（未认证时均为 undefined）。`loopback` 以 `Host` 头为准而不是 socket：经 frp/Caddy 转发的手机流量虽然落在回环 socket 上，Host 却是 FQDN，因此以 Host 为准。处理器用 `ctx.connection.caller.current()` 读取该身份，无需自行解析头。`ctx.connection.callerOf(request)` 为 Connection 不经手的载体（如 WebSocket 升级）推导同一身份；`ctx.connection.onSessionsRevoked(listener)` 在 `sessions.revoke`、`certificates.revoke` 与 `logout` 各自真正撤销会话时报告被撤销的 sessionId 列表——监听器抛错既不影响撤销结果，也不影响其余监听器，返回的 disposer 用于退订。

<a id="connection-generation"></a>
## Connection generation

API Gateway Client 把内部 `$events` 逻辑流注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、Remote 流报错、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。默认情况下，挂起的握手在 3 秒后记录 Host 响应缓慢告警，在 15 秒后记录就绪超时并中止，包含等待物理 socket 的时间。取消后，source 必须停止投递、释放资源并结束，替换 source 才能启动；已取消 source 迟到的 ready 不能发布 generation。浏览器报告网络可用时，Controller 发布 `connecting`，并在 500ms、1s、2s、4s、8s 与 10s 上限内采用 50%–100% 抖动重试，达到终档后继续尝试直到恢复。每次重试都要求 Gateway 替换一次物理 WebSocket，再重开 `$events`。[持续恢复决策](../../../.agents/notes/implemented/bug-fix/2026-09-05-continuous-client-recovery.zh.md)规定握手期限与重试策略。

`ctx.connection.reconnect()` 会中断活动工作、重置序列，并立即开始 retry 1。浏览器 `offline` 会中断活动工作、发布 `disconnected` 并暂停自动尝试；下一次 `online` 转换会重置序列并从 500ms 档开始。只有 ready 项会发布 `connected`。Gateway mux 不拥有独立重试调度。

可通过 Host Connection 行的 `config.recovery` 覆盖重试上限、增长因子或握手告警与取消时间；[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-connection)列出接受的字段。Host 校验这些值，并将其注入所提供的每个页面。Client 在提供 Connection 前校验启动数据，并在 Gateway 启动循环时采用这些默认值；显式传给 `start()` 的时序覆盖优先。增长因子必须是至少为一的有限数。若就绪、失败、取消或硬期限先于告警发生，该告警会被取消。修改 Host 恢复配置后需重新加载页面。


<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **缓冲型 `/api` 路由会把每个请求体保留在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）限制普通图片与 RPC 信封。显式启用的流式路由接收带背压的分块并绕过总量上限；路由实现负责持久化、取消与存储配额。
- **会话登记只属于单个进程和单个数据目录**：登记不会跨进程或跨设备共享，受信代理报告的序列号除外；共用同一凭据文件的并发进程各自保留 last-write-wins 的登记快照，不做合并。撤销（包括按证书撤销）在 DSH 自身的检查处生效：被撤销会话中已被接受的 mux 连接由 API Gateway 以 close code 4401 关闭；这些检查不约束宿主机上同用户的其他进程——凭据文件本就对它们可读。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。浏览器会话验证同步读取内存中的会话登记表；登记快照每次激活加载一次，并经 credentials 提供方持久化，记录 commit-event 生命周期由 credentials 伴生入口负责。流与重连的时序及 rpcId 往返约束由行为规范直接验证，路由注册与 dispose（资源释放）的对称性由 webserver 伴生入口审计。
