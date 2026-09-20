---
description: "可选启用的宿主专属试验版实例管理器，服务于自开发战役：为已通过的任务构建其工作区，在分配到的回环端口上以实验数据目录启动其 `dsh web`，并在试验版关闭前一直拥有该进程组。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-trial

[English](README.md) | 中文

<a id="summary"></a>
## 概述

不止是读到自开发任务的结果，而是能看到它跑起来。任务的工作区准备好后调用一次 `openTrial`——以后战役通过会自动触发——本包就会用工作区自己的 `pnpm` 构建它，在回环端口上启动它的 `dsh web`，并让这个进程一直存活，直到你关闭它或服务本身卸载。每次打开都会重新构建，所以要为它预留构建所需的时间。只有稳定版宿主能打开、关闭或列出实例；手机端调用方可以看进展，但自己不能打开或杀掉进程。

## 目录

- [Service](#service)
- [openTrial 做了什么](#what-opentrial-does)
- [存储与脱敏](#storage-and-redaction)
- [战役通过后的自动打开](#automatic-open-on-a-passed-campaign)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentTrial`（默认导出，Cordis 服务 `selfDevelopmentTrial`）声明注入 `selfDevelopmentRemote`，因此 Remote 门面先加载；它只通过 `getTask` 读门面，且只为了读取某任务已存储的启动档案。本服务不注册自己的工具、提示或持久化存储——它唯一的状态就是控制目录下的 sidecar 文件，以及它当前拥有的子进程。

| 方法 | 约定 |
|---|---|
| `openTrial(taskId)` | 打开（或复用）某任务的试验版实例；细节见[openTrial 做了什么](#what-opentrial-does)。仅限宿主。 |
| `closeTrial(taskId)` | 停止某任务的实例（先 SIGTERM，等五秒宽限，再 SIGKILL），并删除其登记。任务没有存活实例时仍会清掉过期的 sidecar。仅限宿主。 |
| `trials()` | 列出本进程当前拥有的存活实例，按任务 id 排序。进程重启后从 `[]` 开始：实例从不从 sidecar 复活。仅限宿主。 |

| 配置字段 | 含义 |
|---|---|
| `nodeBinary` | 用于启动工作区 `apps/cli/lib/bin.js web` 的 Node 二进制绝对路径。 |
| `controlDirectory` | 本服务拥有的绝对目录；它只在其下写自己的 `trials/<taskId>.json` sidecar 与 `trials/<taskId>.log` 文件。 |
| `portRange` | 试验版实例分配端口所用的闭区间 `[from, to]`（回环地址）。 |
| `buildTimeoutMs` | 单次工作区构建允许的最长墙钟时间，超时则本次打开失败；默认 20 分钟。 |
| `readyTimeoutMs` | 等待 web 进程打印 `dsh web: http://…` 就绪行的最长时间；默认 60 秒。 |
| `autoOpen` | `campaign-passed` 事件到达时是否自动打开该任务的试验版实例；默认 `true`。 |
| `pnpmBinary` | 构建时优先尝试的 pnpm 绝对路径。默认不设置；不设置或不存在时依次退回宿主 `PATH` 上的 `pnpm`、工作区自己安装的 pnpm、`nodeBinary` 旁边的 corepack shim。 |

配置在构造时校验：`nodeBinary`、`controlDirectory` 或配置了的 `pnpmBinary` 不是绝对路径、`portRange` 的某个端口越出 1–65535 或区间不是升序、任一超时不是正整数——这些都会让挂载直接失败，而不是留到后面某次打开时才退化。

每个方法都先调用 `assertCallerIsHost`：没有连接服务时，或在任何 `@Remote` 请求之外，调用都记为稳定版宿主——这与 Remote 门面自身在判定"谁能设置隔离字段"时用的是同一套读法。非宿主调用方会被以 `self-development/host-only-field` 拒绝；它仍可以通过门面观察任务进展。

-----

<a id="what-opentrial-does"></a>
## openTrial 做了什么

`openTrial(taskId)` 通过门面的 `getTask` 读取任务已存储的启动档案。档案没有 `dataHome` 时，退回到受监督 runner 配置的 `dshHome`——通过 `ctx.get('selfDevelopmentRunner')` 结构式读取，这样本部署就不必直接依赖 runner 包；两个来源都没有则以 `self-development/trial-unavailable` 拒绝。一旦工作区与数据目录都确定：

1. **DSH 仓库判定。** 工作区根目录的 `package.json` 必须命名为 `@deepseek-ai/dsh-root`。不满足这一判定的工作区——比如一个普通的 demo 仓库——会返回 `{ url: undefined, reason: 'worktree is not a DSH repository; artifacts at <path>' }` 而不是一个实例；不会有任何构建或启动发生。
2. **构建。** 在工作区内运行 `pnpm run --silent build`，并透传宿主自己的环境（`PATH`、`HOME` 等），好让解析出的 pnpm 能找到它自己的依赖。用哪个 pnpm 跑，按顺序试：配置的 `pnpmBinary`、宿主 `PATH` 上能找到的 `pnpm`、工作区自己安装的 pnpm、`nodeBinary` 旁边的 corepack shim——每一个不存在的候选都只是跳过，不算失败。所有候选都找不到、以非零码退出、或跑过 `buildTimeoutMs`，才会让本次打开以 `self-development/trial-build-failed` 失败；无论哪种情况，构建的 stdout 与 stderr 都会流入该任务的日志。
3. **端口分配。** 在 `portRange` 中扫描第一个空闲的回环端口，跳过本进程已经分给存活实例的端口。区间耗尽则以 `self-development/trial-port-exhausted` 拒绝。
4. **启动。** 在工作区内运行 `node apps/cli/lib/bin.js web --host 127.0.0.1 --port <port> --no-open`，`DSH_HOME` 设为解析出的数据目录，以独立进程组方式后台启动。实例的地址从其输出的第一行 `dsh web: http://…` 中读取；进程退出、或在 `readyTimeoutMs` 之前始终没有打印这一行，都会让打开以 `self-development/trial-start-failed` 失败，并且在抛出失败之前会先把进程组收尾掉。

对已有存活实例的任务重复调用 `openTrial`，会原样返回该实例——不会再构建、再启动、再占端口。任务 id 未通过核心自身校验（比如一个带路径转义的 id）会在任何这些步骤之前就以 `self-development/config-invalid` 拒绝。

-----

<a id="storage-and-redaction"></a>
## 存储与脱敏

每个存活实例的事实信息——地址（含真实启动 token）、端口、pid、启动时间、工作区、数据目录——会被原子写入 `<controlDirectory>/trials/<taskId>.json`，权限 0600，位于服务以 0700 权限创建的 `trials` 目录下。地址在这里保留真实 token，是因为这个 sidecar 正是人类或其它宿主侧调用方用来在浏览器里实际打开该实例的地方。

构建与 web 进程合并后的输出会随到达流入 `<controlDirectory>/trials/<taskId>.log`，写入前会先把每个 `?token=…`/`&token=…` 查询值替换为 `<redacted>`——日志是共享的诊断产物，即便它旁边的 sidecar 带着可用 token，日志本身永远不会带。`closeTrial` 与 `trials` 不会碰日志；只有 `openTrial` 的构建与启动步骤会向其追加内容。

-----

<a id="automatic-open-on-a-passed-campaign"></a>
## 战役通过后的自动打开

当 `autoOpen` 为 `true`（默认值）且能结构式读到一个事件消费方时——通过 `ctx.get('selfDevelopmentEvents')` 读取，这样本包也不必直接依赖 events 包——本服务会订阅其通知，并在 `campaign-passed` 事件点名某任务时自行调用 `openTrial`。本 worktree 的 events 消费方目前还不会发出这种事件种类；在上游把这层映射接上之前，这条订阅会一直处于静默状态，届时这里不需要再做任何改动。

自动打开失败时——构建失败、端口区间耗尽、或任何 `openTrial` 可能拒绝的原因——既会记一条服务日志的警告，也会追加进该任务自己的 `trials/<taskId>.log`，这样即使没人盯着宿主的通用日志也能看到失败；无论哪种记法，失败都绝不会向外传播，因为一次通知不应导致拒绝。该任务仍然可以通过显式调用 `openTrial` 来关闭或重新打开。

-----

不发布运行时 invariant 配套模块：本服务没有自己的运行时观察流，它拥有的一切关系——每个任务一个实例、每个实例一个登记的进程组、日志不含启动 token——都由针对真实子进程的行为测试覆盖。

<a id="model-experience"></a>
## Model Experience

无：本服务不注册任何面向模型的工具、提示或事件，且每个方法都会拒绝非宿主调用方。手机侧的模型或 UI 从不直接调用 `openTrial`/`closeTrial`/`trials`；它通过 Remote 门面观察任务进展，未来若有聊天侧的入口，也会从那个入口获知试验版地址，而不是直接依赖本包。

#### KV Cache effect

无。本服务不接触提示、会话或请求路径，KV-cache 复用不受影响。

## Known Limitations and Deferred Work

- **没有操作系统级别的隔离。** 试验版实例只是宿主机上的一个普通子进程，用实验自己的数据目录启动，运行的是工作区构建产出的任何代码；除了绑定在 `127.0.0.1` 之外，没有沙箱或网络限制。
- **每次打开都重新构建，任务之间不共享构建缓存。** 每次 `openTrial` 都会在自己的工作区里跑一次全新的 `pnpm run --silent build`；本包不在任务之间、也不在同一任务的重复打开（在其实例已退出之后）之间共享任何构建产物。
- **实例不会在进程重启后存活。** 重启后 `trials()` 从 `[]` 开始，即便某个 sidecar 可能仍然写着一个 pid：本服务只跟踪自己在本进程里启动过的实例——这与受监督 runner 的进程组模块"只认自己 spawn 的记录"的归属原则一致，绝不会按进程名或仅凭一个存储的 pid 去发信号。
- **`campaign-passed` 的接线目前是替身。** 本服务监听的这个事件种类在本 worktree 里还不存在；在上游的映射落地之前，自动打开只会在某个部署通过 `internals.events` 或 `ctx.selfDevelopmentEvents` 自行提供兼容的事件源时才会触发。
- **构建步骤的 `nodeBinary` 参数目前未被使用。** `runBuild` 保留这个参数只是为了与 `resolveBuildCommand`（真正用它解析 corepack 兜底路径的地方）签名对称；构建命令本身在 `runBuild` 运行之前就已经解析完毕。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
