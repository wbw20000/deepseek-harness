# Agent Note: Supervised runner helpers fail closed

Status: implemented

English | [中文](2026-09-18-supervised-runner-fail-closed.zh.md)

## Problem

A direct child can exit successfully while descendants still write, output was truncated, or an assertion reached a file outside the experiment through an ancestor symlink. Treating these observations as success makes a later task verdict unreliable. The [task-control foundation](../../proposed/feature/2026-09-18-self-development-task-control-foundation.md) owns task state and approved budgets; these helpers own process and filesystem observations, not task approval.

## Decision

The supervised executor fails on stdout overflow and fixes the SIGTERM-to-SIGKILL deadline at the first stop trigger. Its first session event fixes the reported identity. Acceptance overflow fails all assertions. Both helpers confirm that the original POSIX process group has disappeared after pipe closure; errors or a bounded confirmation timeout reject the run. Windows execution is refused before launch.

Acceptance placement and file paths resolve through the filesystem, with missing roots refused and paths checked again at use. Artifact symlinks contribute link text, never external target bytes. Presence evidence owns a copy of the validated confirmation. Tests abort and await only their owned runs; they do not kill processes by fixture name.

## Alternatives considered

**Return at direct-child exit.** This cannot establish that descendants stopped modifying the worktree. The helper waits for pipe closure and final group-exit confirmation instead, at the cost of a bounded additional wait and possible refusal for unreaped processes.

**Keep truncated output and trust retained assertions.** Missing output can hide later events and invalidates a complete-run verdict. Overflow fails closed even when the retained prefix contains a success marker.

**Treat a working directory and environment whitelist as isolation.** Neither removes the child's operating-system permissions. The supervised route records this limitation instead of claiming unattended protection.

## Consequences

The helpers stop common accidental escapes and refuse incomplete observations, but they are not an independent supervisor or sandbox. Descendants that change process groups, reuse of numeric process-group ids, concurrent same-user file replacement, wall-clock changes, host failure, and sleep require stronger supervision. No automatic task loop, launch approval, evidence pipeline, or installation upgrade is enabled by these helpers. Regression tests cover ordinary completion with a surviving descendant, repeated stop triggers, output overflow, ancestor links, missing roots, and mutation of a presence input.
