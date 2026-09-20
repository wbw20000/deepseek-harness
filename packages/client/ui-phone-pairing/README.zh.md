---
description: "稳定侧手机配对 UI：一个设置分区，把一次性配对链接铸造成二维码、列出已配对的浏览器会话，并在风险确认之后撤销其中一个，全部经由 Connection 自己的会话路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-phone-pairing

[English](README.md) | 中文

## 概述

本包给 Web 客户端加一个标题为**手机配对**的设置分区。在稳定主机上（loopback 连接），它通过 Connection 的 `POST /api/connection.pairing.mint` 路由铸造一次性配对链接，渲染成手机可扫的二维码，显示链接和复制按钮，并对令牌做到期倒计时。在任何地方（包括手机上），它都列出已注册的浏览器会话，并经第二次确认对话框撤销其中一个。二维码编码器是本包自己的实现（字节模式、M 等级、版本 1–10），因此配对令牌不必离开浏览器就能画出来。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

该分区在设置页以序号 46 渲染，紧跟附件分区之后。它没有主机侧行为：node 入口的 `apply` 什么都不注册，分区发出的每个请求都是同源 `fetch`，带着桌面端已持有的浏览器会话 cookie。三个路由、它们的鉴权以及"只有主机能铸造"的规则都归 Connection 所有。

### 启用分区

默认 web bundle 已在名册（`packages/bundle/web-app/cordis.patch.yml`）里列出本插件，所以 `dsh web` 无需额外配置就显示该分区。删掉名册里的那一行即移除分区；路由仍留在 Connection。

### 铸造配对链接

| 字段 | 含义 |
| --- | --- |
| 设备名称 | 会话注册时使用的标签；出现在会话表和 Connection 的 `.credentials.yaml` 里。 |
| 有效期 | 5 或 10 分钟；Connection 把配对令牌上限定为十分钟，所以下拉框不提供更长的选项。 |
| 生成配对链接 | 把 `{ deviceLabel, ttlMs }` 发到铸造路由并显示结果：二维码、链接文本、复制按钮和倒计时。 |

铸造出的链接只能用一次：第一个打开它的浏览器被注册为会话并拿到 cookie；第二次打开返回 401。令牌只存在于本组件的状态里；分区从不记录它，主机时钟越过 `expiresAt` 后倒计时会把链接换成过期提示。

分区显示的链接就是 Connection 铸造出来的那个。在中继之后（手机经公网 origin 访问主机）要配置 Connection 的 `publicOrigin`，让铸造出的 URL 指向手机能到达的 origin，而不是请求本身的 loopback 地址；不配置的话二维码编码的是一条只有桌面端能打开的链接。

### 在手机上

Connection 对非 loopback 调用方的铸造请求回 403。分区读取 Remote 服务的 `$host.isLoopback` 事实，在手机上把铸造表单藏在一行说明之后，只保留会话表，让手机能看到并撤销自己或其他会话。

### 会话表

表格显示每个已注册会话（含已撤销的），列出设备、登录时间、到期时间和状态，并带一个刷新按钮。**撤销**会打开一个写明设备名的 `RiskConfirmation` 对话框；必须勾选知情复选框，确认按钮才会发出撤销请求。撤销在主机侧立即生效：该会话的 cookie 不再通过鉴权，其 mux 连接被关闭，因此已配对的手机在一次重连之内就会掉线。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部——点击展开</summary>

`src/client/index.ts` 注册 `phonePairing` 词典和一个 `settings.section` 席位，其注入面携带 fetch 端口（`fetchPairingApi` 包在 `internals.fetch` 上，后者是默认取窗口 `fetch` 的测试钩子）、来自 `ctx.remote.$host.isLoopback` 的 `phone` 标志，以及一个让倒计时可测的 `now` 时钟。`src/client/api.ts` 组装三个请求，并把非 2xx 回复转成携带服务端文本的 `Error`（Connection 写的是整句话，例如 `connection: pairing links are minted from the stable host only`），响应体为空时则为 `HTTP <status>`。`src/client/qr.ts` 是编码器：它选出 M 等级容量能装下 UTF-8 载荷（最多 213 字节）的最小版本（1–10），构造码字（模式与计数指示符、终止符、填充字节），按块在以 0x11d 为本原多项式的 GF(2^8) 上计算 Reed–Solomon 校验并交织各块，放置定位、定时、校正和暗模块图案，写入格式信息（BCH(15,5)，以 0x5412 掩码）以及从版本 7 起的版本信息（BCH(18,6)），再用四条惩罚规则给八种掩码打分并保留最低分。`qrToSvg` 和面板里的 `QrCode` 在四模块静区内为每个暗模块渲染一个 `rect`。编码器已用 macOS Vision 的条码检测器验证过每个版本边界和多字节 UTF-8 载荷。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Connection](../connection/README.zh.md)——会话注册表、配对铸造与撤销路由、`publicOrigin` 以及受信主机围栏。
- [推送注册表](../../notify/push-registry/README.zh.md)——与会话配对的手机侧通知注册。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)

未发布运行时不变量伴生件，因为该分区只驱动三个不归它所有的 Connection 路由，不断言它们之间任何可独立观察的关系。

<a id="model-experience"></a>
## 模型体验

无，因为该分区只经由 Connection 的路由铸造、列出和撤销浏览器会话，不贡献模型可见输入。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 铸造出的链接在到期前无法作废：Connection 没有取消配对令牌的路由，所以分区不提供取消按钮，只依赖十分钟上限。
- 二维码编码器覆盖 M 等级字节模式到版本 10（213 字节）。更长的配对 URL 不会被画出来；此时分区只显示链接文本和复制按钮。
- 在中继之后，只有配置了 Connection 的 `publicOrigin`，铸造出的链接才正确；分区无法识别 loopback 链接，会照常显示为已铸造。
- 这里不管理每设备客户端证书：会话表不显示 Connection 可能记录的证书序列号，证书的签发、分发和撤销仍是部署任务。
- 会话表在加载时、撤销后和点击刷新时刷新；它不订阅会话变化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

测试通过 `internals.fetch` 注入一个记录式 `fetch`，并用 `@testing-library/react` 驱动面板；二维码测试解码的是结构（定位图案、格式位、版本位）而不是像素，Vision 验证作为部署证据放在仓库之外。让 `TTL_MINUTES` 保持在 Connection 的上限之内，并让铸造表单在手机上保持隐藏：403 是 Connection 的规则，隐藏表单只是它礼貌的一面。

</details>
