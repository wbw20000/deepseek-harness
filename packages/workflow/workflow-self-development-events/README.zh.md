---
description: "可选启用的自开发通知投影：把持久任务提交折叠为统一的事件级标题事件，提供内存 recent 缓冲、进程内订阅回调，以及可选的 macOS 本地通知命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-events

[English](README.md) | 中文

<a id="summary"></a>
## 概述

无需盯住控制器即可跟踪自开发任务进展：每次持久任务提交都会折叠为一个统一事件——需要人决定、待试用、失败或停止的通知——你可以从内存缓冲中拉取、在进程内订阅，或通过自行配置的命令发布为 macOS 本地通知。未配置命令之前通知保持关闭，事件只到标题级：不含路径、凭据或需求全文。缓冲与订阅仅存在于本进程。

## 目录

- [Service](#service)
- [事件模型与映射](#event-model-and-mapping)
- [本地通知](#local-notifications)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentEvents`（默认导出，Cordis 服务 `selfDevelopmentEvents`）声明注入 `selfDevelopmentTasks`，因此任务控制服务先加载。它消费核心包的 `self-development/committed` 事件——每次持久日志提交触发一次。本服务不注册工具、提示或守护进程。

| 方法 | 约定 |
|---|---|
| `recent(limit)` | 按从旧到新返回已保留事件；最多 `limit` 条，省略 `limit` 时返回全部保留事件。 |
| `subscribe(listener)` | 从现在起每个事件调用一次 `listener`，按提交顺序，返回退订函数。缓冲不会向迟到的订阅者重放。 |

| 配置字段 | 含义 |
|---|---|
| `localNotificationCommand` | 通知命令 argv，每个事件 spawn 一次，事件 JSON 从其 stdin 传入。`undefined`——默认值——从不 spawn。 |
| `recentLimit` | 内存缓冲保留的事件数；默认 200。 |

配置在构造时校验：空 argv 或非正整数的 `recentLimit` 会让挂载立即失败，而不是让投递悄悄降级。

-----

<a id="event-model-and-mapping"></a>
## 事件模型与映射

一个 `SelfDevelopmentEvent` 携带 `taskId`、`kind`、`sessionId`、`title`、`occurredAt` 以及提交后的投影 `revision`。`sessionId` 可选且在这里恒为 `undefined`：自开发任务不绑定聊天会话，可选字段让同一事件形状仍可被会话绑定的通知消费方复用。每个标题都是固定英文模板：只包含轮数与封闭词表中的原因，绝不包含自由文本的失败原因或交接细节。

| 持久事件 | Kind | 标题 |
|---|---|---|
| `plan/drafted` | `awaiting-decision` | `Plan drafted, awaiting confirmation` |
| `plan/confirmed` | `awaiting-decision` | `Plan confirmed, awaiting development approval` |
| `budget/approved` | `awaiting-decision` | `Budget approved, task ready` |
| `attempt/failed` | `failed` | `Round N failed` |
| `handoff/raised` | `failed` | `Task handed off (<reason>)` |
| `task/passed` | `awaiting-trial` | `Round N passed, awaiting trial` |
| `task/stopped` | `stopped` | `Task stopped (<reason>)` |

`plan/confirmed` 与 `budget/approved` 通过其留下的"需要人决定"状态（`awaiting-development-approval` 与 `ready`）映射；其余所有持久事件都是控制器簿记，不映射任何事件。轮数 `N` 是该次提交折叠后已消耗的轮数。交接与停止标题中的 `<reason>` 是持久事件词表中的枚举值（`journal-corrupted`、`cancelled` 等）；runner 的失败原因文本与交接细节绝不进入事件——需要全文请查询任务日志。`turn-finished` 保留给未来的有限循环投影——一轮结束并等待下一轮；当前已结束的一轮发布的是 `failed`。

-----

<a id="local-notifications"></a>
## 本地通知

配置 `localNotificationCommand` 后，服务对每个映射事件 spawn 一次该命令，向其 stdin 写入一行 JSON 事件，不期待任何返回。命令在自己的进程组中运行（detached spawn），因此固定的 10 秒超时终止只会到达其子孙进程，不会触及宿主的进程组。失败——spawn 错误、非零退出、超时——只记日志、绝不重试，也绝不会进入缓冲或订阅者。卸载服务时等待在途投递结束。

`examples/macos-notify.sh` 是模板而非随附命令：它用 python3 解析事件 JSON、转义字段，然后用 `osascript` 发布一条通知，标题为任务 id，正文为事件标题。任何 shell 都不会重新解释字段，因此事件文本中的引号、反引号与 `$()` 保持惰性。请审阅后把 `localNotificationCommand` 指向你自己的副本。

不发布运行时 invariant 配套模块：本包没有自己的运行时观察流，它拥有的一切关系——每个映射的持久提交对应一个事件、有界缓冲、每次配置投递对应一次 spawn——都由针对真实任务控制服务的行为测试覆盖。

-----

<a id="model-experience"></a>
## Model Experience

无：本服务不注册任何面向模型的工具、提示或事件。它把已经持久化的任务提交折叠为标题级的人类通知，送达通知中心与进程内监听器，从不进入模型请求或 Session 事件。

#### KV Cache effect

无。本服务不接触提示、会话或请求路径，KV-cache 复用不受影响。

## Known Limitations and Deferred Work

- **事件仅存于进程内，从不持久化**——recent 缓冲与订阅只存在于本进程；重启后 `recent()` 为空，也不会从任务日志重建任何历史。
- **迟到的订阅者看不到任何事件**——`subscribe` 只投递订阅之后观察到的事件；需要历史的 UI 必须在挂载时读取 `recent()`。
- **`turn-finished` 是保留种类，当前不发射**——现有映射不会产生它；在有限循环投影出现之前，消费方不得依赖收到它。
- **失败原因不进入事件**——runner 的失败原因文本与交接细节只存在于任务日志；通知事件只携带轮数与封闭词表中的原因，需要全文的消费方必须读取任务日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
