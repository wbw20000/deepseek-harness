# Notify 子系统

[English](notify.md) | 中文

Notify 子系统在 session-controller 状态变化时向已登记的 iOS 设备投递标题级推送通知。一个 opt-in 的 Cordis 服务拥有登记文档、鉴权 Remote 端点、事件到通知的映射以及出站命令派发器。子系统没有投递队列：宿主在线时观察到的事件立即派发或记录为失败，登记文档是唯一的持久状态。

## 通知值

`NotificationKind` 是封闭集合 `turn-finished`、`turn-failed` 与 `awaiting-confirmation`。`NotificationEvent` 只携带 `kind`、`sessionId`、`title` 与 `occurredAt`。载荷在构造时脱敏：标题是按类型固定的字符串，`awaiting-confirmation` 另加被询问的工具名；session-controller 的错误消息、消息正文、文件系统路径与工具参数永不进入事件。

`PushRegistrationRequest` 由调用方自选的 `deviceId`、封闭的 `platform: 'ios'` 与不透明的 APNs `token` 组成。`DeviceRegistration` 加上登记时间；`DeviceView` 是 `list` 端点返回的无 token 投影。

## 事件映射

| 类型 | 来源事件 | 规则 |
|---|---|---|
| `turn-finished` | `api-session/status`（`running: false`） | 经去重窗口投递。 |
| `turn-failed` | `api-session/error` | 经去重窗口投递；把该会话在窗口内标记为失败。 |
| `awaiting-confirmation` | `approval/request` waterfall | 监听者只观察，随后以 `next()` 委托；从不认领请求。 |

该映射是固定订阅，不是通用事件源 seam：在统一事件模型（M4）落地前，新的可通知场景意味着修改拥有它的包。

## 去重与失败占优

去重键是 `${sessionId}:${kind}`。配置窗口内一个会话的一种事件只发一次通知，与投递结果无关。已记录的 `turn-failed` 还会在窗口内抑制同一会话的 `turn-finished`，一次失败的回合不会通知两次。窗口到期后重新放行。

## 出站投递

每次投递 spawn 配置的 `outboundCommand`，向 stdin 写入一行 JSON——`{ event, device: { deviceId, platform, token } }`——并在单次尝试截止时间内期待退出码 0。子进程以 detached 方式运行，超时停止只向其 spawn 的进程组发信号。非零退出、spawn 失败与超时是可重试失败；预算为额外 `maxRetries` 次尝试，退避 250 ms 起逐次翻倍。每个预算都以一条 `deliveries.jsonl` 记录收尾，含结果、尝试次数、耗时与简短失败原因。投递从事件监听者处即发即弃；卸载时会排干在途扇出。

没有出站命令时，服务只登记与列举设备，从不 spawn。

## 存储

`devices.json` 存放已校验的登记文档，在跨进程写锁下以原子重命名提交，权限 0600。损坏的文档让下一次操作即刻失败，绝不会被重置。`deliveries.jsonl` 只追加且不含 token。token 只存在于该文档中——不出现在日志、投递记录或 Remote 响应里。

## Remote 端点

`register`、`unregister` 与 `list` 是 `pushRegistry` 命名空间下的直接 Remote 方法，由现有鉴权连接层服务。登记请求在服务处校验：空 id、空 token 与非 iOS 平台即刻失败。
