---
description: "稳定侧自开发任务 UI：任务列表、确认卡、每轮证据时间线，以及右侧栏页签与设置分区中的显式人工授权按钮。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-self-development

[English](README.md) | 中文

## 概述

本包在 Web 客户端渲染自开发工作流的稳定侧：一个标题为**自开发任务**的右侧栏页签和一个设置分区，两者显示同一个面板。面板列出任务及其状态徽标与版本，原样渲染确认卡的固定措辞，绘制每轮证据时间线，并恰好提供六个人工授权操作。授权只来自这些按钮；普通聊天不会产生任何授权。

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

页签与设置分区渲染同一个面板并共享状态。未选中任务时面板显示任务列表；选中任务后面板显示确认卡（全字段、按远端门面给的固定措辞原样呈现）、投影摘要（版本、已用预算、进行中的轮次、已验证结果摘要、停止与接手原因）、当前状态允许的授权按钮、每轮证据时间线，以及试验版路径。

### 启用该表面

默认 web bundle 不包含任何自开发内容：浏览器花名册没有本面板行，Host 服务也未加载，因此不存在自开发页签或设置分区。要启用整条链路，请携带捆绑的 overlay 启动 web 表面——它会同时加载 Host 任务控制服务、监督运行器、通知消费方、Remote 门面（`enabled: true`、`allowedActors` 留空）与浏览器面板行：

```sh
dsh web --patch node_modules/@deepseek-ai/dsh-web-app/overlays/self-development.overlay.yml
```

使用前请把 overlay 里的占位路径替换为本部署的目录；各 Host 包的 README 说明各自的字段。去掉该 overlay 即同时移除页签与服务。

### 按钮与远端方法

每个写操作都要先经过带勾选确认框的二次确认对话框，才会发出调用。

| 按钮 | 提供该按钮的状态 | 远端方法 |
| --- | --- | --- |
| 新建任务 | 任何时候（列表上方的表单） | `createTask` |
| 提交计划草稿 | 规划已授权（表单：多条用例加人工用例） | `submitPlanDraft` |
| 授权规划 | 草稿 | `authorizePlanning` |
| 确认计划 | 待确认计划（先展示自动测试项与人工项） | `confirmPlan` |
| 批准预算 | 待批准预算（显式表单：模式、轮数、时限、阶段超时、步数、无进展上限） | `approveBudget` |
| 启动一轮 | 待启动或进行中 | `runAttempt` |
| 停止 | 任何运行中的状态 | `stop` |
| 记录试用批准 | 待试用，绑定当前已验证结果；已有批准时禁用并显示批准人 | `recordTrialApproval` |
| 保存为档案 | 无档案任务的启动区 | `setLaunchProfile` |

### 一键启动与启动档案

**启动一轮**区的字段来自任务的启动档案（`card.launchProfile`）：默认视图是四行只读值（worktree、验收产物、验收定义路径、确认人）加预算、在场勾选框和一个按钮。勾选在场是启动所需的唯一输入；确认对话框列出这四个生效值与预算，请求随后只携带 `taskId`、`expectedRevision` 与 `presenceAcknowledged: true`。**高级（覆盖档案）**折叠区保留原来的五个自由输入框，逐项覆盖档案值；填写的覆盖项就是请求额外携带的全部字段。任务没有启动档案时高级区自动展开并提示，**保存为档案**把填好的字段经 `setLaunchProfile` 存储。

### 新建任务与计划草稿表单

**新建任务**在列表上方展开表单：需求、允许修改范围（逗号分隔）、稳定基线摘要（64 位 hex——取当前 HEAD 的 sha256）与创建人；创建人在本浏览器内记忆，下次自动预填。可选启动档案（worktree、验收定义路径、验收产物）在填写后作为 `createTask` 的第三个参数。**提交计划草稿**在任务处于"规划已授权"时出现：用例行（用例 ID、需求、逗号分隔的断言 ID）可增删，人工用例是逗号分隔列表，填了一半的行会被丢弃而不是提交。

### 未启用与手机白名单

组合未加载生成的 `selfDevelopmentRemote` 命名空间时，面板渲染"未启用"视图而不是报错；普通聊天组合不会产生任何授权。在手机上（非回环 Host 连接）白名单保留所有读操作与全部白名单授权按钮，用一条提示隐藏试验版与证据路径，用仅 Host 可见的提示（`self-development/host-only-field` 文案：只能查看、确认与停止）替换启动区，并且不渲染档案表单的仅 Host 字段。

### 每轮证据

时间线在每次列表刷新与手动刷新时读取 Remote 门面的 `recentEvents`（事件消费方的标题级最近缓冲）；没有独立的实时订阅，wire 上也没有第二个事件源。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

浏览器面注册页面型右侧栏页签（类型定义加键控的 `sidebar.right.pane.tab` 主体）和一个 `settings.section` 座位；两处经同一注入面渲染 `SelfDevelopmentPanel`。生成的 `selfDevelopmentRemote` 命名空间由 `@deepseek-ai/dsh-api-remotes` Client 装配的 mount 列表挂载；插件经就绪 fiber 读取它：组合未提供时 fiber 保持挂起，提供时经注入 `hooks` 舱翻转一个注册方私有的可用性事实。`status.ts` 持有唯一的状态到按钮矩阵；面板恰好渲染这些操作，因此不存在需要隐藏的升级操作。`wire.ts` 用表单文本构造每个请求并渲染门面的错误码词表；门面在 wire 边界重新校验每个请求。全部文案位于类型化的 `locales.ts` 字典；样式表在 480px 及以下保持单列。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [自开发远端门面](../../workflow/workflow-self-development-remote/README.zh.md)
- [自开发事件](../../workflow/workflow-self-development-events/README.zh.md)
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)

<a id="model-experience"></a>
## 模型体验

### 用户驱动的授权面板

#### 模型看到什么

无；面板渲染工作流核心已记录的任务状态，并经 `runAttempt`、`stop` 等 `selfDevelopment` 远端方法收集人工授权。

#### Token 影响

无；面板不发送 provider 请求，不新增模型可见内容。

#### KV Cache 影响

无；面板经现有 Remote 门面与 Host 通信，不新增模型可见表面。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 升级批准不属于本面板；这里和远端门面上都没有升级按钮，本面板也不得增加。
- `presenceAcknowledged` 没有默认值：请求携带 `true` 仅因对话框的勾选确认框被勾选，否则门面拒绝请求。
- 面板渲染门面报告的内容；除自身的刷新按钮外不轮询任务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明 — 点击展开</summary>

不发布运行时 invariant companion。面板渲染两个不归自己所有的可选 Host 面，不断言二者之间可独立观测的关系。

</details>
