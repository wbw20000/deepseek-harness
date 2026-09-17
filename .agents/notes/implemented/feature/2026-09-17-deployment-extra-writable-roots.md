# Agent Note: Deployment-approved extra writable roots

Status: implemented

English | [中文](2026-09-17-deployment-extra-writable-roots.zh.md)

## Problem

A deployment can need writes in a second project tree without granting unrestricted filesystem writes. Granting that tree only to shell commands leaves filesystem tools unable to perform the same task; granting a broad parent also exposes unrelated projects.

## Decision

`sandbox-policy` accepts optional absolute `extraWritableRoots`, deduplicates their execution-world spellings, and carries them on each resolved policy. Local enforcing providers canonicalize paths; SSH preserves them until enforcement on the remote host. The filesystem fence, bwrap, Landlock, and Seatbelt consume the same configured roots only in `workspace-write`. Empty configuration preserves existing policy fields and model-visible text. Configured roots appear in the logged current-policy context.

The Windows ACL runner refuses this combination before creating grants or launching a child. Its deterministic workspace SID grants standing access: reusing that identity for extra directories would leave access after the configuration removes a root. The existing workspace and private-temp lifecycle remains unchanged.

## Alternatives considered

**Unrestricted mode or a broader workspace parent:** both authorize unrelated writes. An explicit deployment list preserves narrower access.

**Persistent extra-directory Windows ACLs:** removing a configured path would not remove its standing permission. Support requires a separately verified revocable permission lifecycle, not just additional runner arguments.

**Tool-specific allowlists:** shell and filesystem operations would disagree. Resolved execution policy supplies both consumers.

## Consequences

The setting is deployment-wide, not a per-task permission grant or a self-development isolation guarantee. It does not restrict reads, network access, or process control. Configured directories must exist in the execution world; unsupported backend combinations fail rather than silently widening access. Already-running subprocesses retain their original sandbox profile; changing configuration affects subsequent confinement, not existing processes.

Policy, root, filesystem, local-profile, ACL-refusal, and SSH tests cover the consumers. Real Seatbelt tests check allowed and adjacent denied writes; the `session-sandbox-extra-roots` recording checks the logged policy and filesystem result. Windows native behavior remains the Windows CI lane's responsibility.

## Related

The [sandbox decision](2026-07-06-sandbox.md), [cross-family policy decision](2026-07-14-cross-family-fs-sandbox.md), and [Windows ACL decision](2026-08-08-windows-acl-restricted-token-sandbox.md) retain their independent enforcement, escalation, and identity rationale. This decision resolves only the extra-root deferral; it does not replace those records or add ACP per-session directory grants.
