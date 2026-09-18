---
description: "面向出站设备通知维护者的包映射：opt-in 的 push-registry 服务及其会话事件出站派发器。"
kind: "package-group"
---

# notify/ — 发往已登记设备的出站通知

[English](README.md) | 中文

## 概述

Notify 系列把 session-controller 的状态变化转成发往已登记 iOS 设备的标题级推送通知。一个 opt-in 服务拥有设备 token 登记、鉴权 Remote 端点、带失败占优的去重窗口，以及 stdin 连接的出站命令。投递是即发即弃并记录结果；token 绝不离开登记文档。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`push-registry/`](push-registry/README.zh.md) | 设备 token 登记、会话事件订阅与出站投递 | `ctx.get('pushRegistry')`（opt-in；默认组合不挂载） |

<a id="related-documentation"></a>
## 相关文档

服务的事件映射、脱敏规则、去重与重试语义以及存储布局由 [Notify 子系统参考](../../docs/subsystems/notify.zh.md) 拥有。包 README 拥有 Remote 方法契约与部署配置。

<a id="dev-note"></a>
## 开发备注

无。
