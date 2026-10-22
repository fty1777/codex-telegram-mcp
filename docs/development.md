# Developer reference

[Back to the README](../README.md)

## Checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests-bun
```

The runtime requires Linux for its process ownership safeguards. Installed plugins
use bundled JavaScript and the existing Bun executable. They do not require the
checkout or `node_modules` after installation.

## Marketplace package

The catalog is `.agents/plugins/marketplace.json`; the stable selector is
`codex-telegram-mcp@fty1777`. Its package lives in `plugins/telegram/` and uses the
portable `plugin.json` and `mcp.json` manifests. Codex resolves the plugin working
directory; Bun then runs `./bridge.js` from there (verified on Codex 0.163.0). No launcher argument depends
on compatibility-format variable substitution. The `plugin` CLI entry
starts the shared channel with the installed package's identity. It does not
require or overwrite the legacy installer's `manager-installation.json` receipt.
Pairing and explicit binding attach a bot to this installation. Startup refreshes
cached paths only for bots already assigned to this plugin.

Rebuild the committed bundle after runtime changes:

```sh
bun install --frozen-lockfile
bun run build:plugin
bun run typecheck
bun test tests-bun
bun scripts/probe-marketplace.ts
bun scripts/probe-marketplace.ts --upgrade
```

The build copies license notices and gathers licenses for bundled dependencies.
Commit the generated `plugins/telegram/` files with their source changes. Keep
`package.json` and the generated plugin version in sync; bump the version for a
release. Publish only the intended branch and release files, never local archive
branches or private runtime state.

The marketplace probe copies only the distributable package into a temporary
catalog and installs it with isolated `HOME` and `CODEX_HOME`. It starts a real
Codex App Server and one disposable thread, then calls the plugin through Codex.
It does not rewrite launch arguments or emulate plugin-root substitution. It
runs no model turns and makes no Telegram requests. `--hot-load` instead installs
after creating the thread and checks dispatch after a refresh. On Codex 0.163.0,
this can discover tools while dispatch in the existing thread remains unavailable;
the probe reports failure rather than equating discovery with successful use.
The default fresh-session probe must successfully call `list_bots`.
Pairing, receiver readiness
and real round-trip delivery still need separate checks.

For source-checkout development, the existing `bun run bridge install` installer
remains available. Verify the target plugin before handing over the connection,
as described in [setup](setup.md#an-existing-telegram-integration).

## Code map

| Module | Responsibility |
| --- | --- |
| `bun/channel.ts` | Shared native MCP tools and session-owned bot receivers |
| `bun/engine.ts` | Public Codex events, incoming messages, and Telegram commands |
| `bun/commands.ts` | Shared command menu and native Codex slash commands |
| `bun/session-commands.ts` | Model settings, planning, reviews, and discovery queries |
| `bun/telegram.ts` | Bot API transport and durable send receipts |
| `bun/format.ts` | Markdown conversion, quote styling, and message splitting |
| `bun/timing.ts` | Persistent task clocks and elapsed-time display |
| `bun/usage.ts` | Reported token snapshots and per-turn accounting |
| `bun/pairing.ts` | Pairing proof and shared CLI/tool setup completion |
| `bun/management.ts` | Bot discovery and session handoff |
| `bun/manager-install.ts` | Shared plugin installation and upgrades |
| `tests-bun/` | Transport, ownership, pairing, formatting, and delivery tests |

## Setup and recovery reference

`doctor` must reach the shared local Codex App Server; the installer does not start
one. It reports the executable paths and server version. Compare `codex --version`
when diagnosing a mismatch. A standalone terminal may need to reconnect using the
resume command printed by the session guard.

A newly installed plugin may need a conversation reload to expose its tools.
Finish active work before reloading the same conversation. Adding bots to an
already loaded plugin does not require a reload.

Use native tools normally. The rescue CLI supports:

```sh
bun run bridge pair-begin NAME --session SESSION_ID --token-file PRIVATE_TOKEN_FILE
bun run bridge pair-check NAME --session SESSION_ID
bun run bridge pair-watch NAME --session SESSION_ID
bun run bridge pair-status NAME --session SESSION_ID
bun run bridge pair-confirm NAME --session SESSION_ID --code PAIRING_CODE
bun run bridge pair-cancel NAME --session SESSION_ID
bun run bridge bind NAME --session SESSION_ID --activate
```

Keep the token file private. `pair-confirm` saves pairing, attempts receiver startup,
and journals the same acknowledgement as the native tool. A startup failure leaves
pairing saved; inspect state before retrying activation. Expired or exhausted
pairing windows must be cancelled before replacement.

`pair-check` reads once. `pair-watch` runs in the foreground until expiry,
cancellation, redemption or a terminal error; it retries transient reads with
bounded backoff. Keep that process alive while the user sends `/start`, or use
the native tools, whose MCP host owns the watcher. `pair-status` queries the
window without another Telegram read. Inspect `polling.status`, `last_success`,
`reason` and `code_delivery`; a candidate count alone does not prove code delivery.
Unknown code sends are never replayed. Expired windows remain queryable.
These are rescue tools, not additional user setup steps. Prefer the native
pairing tools and their built-in watcher. If they are missing, resolve tool
loading before claiming that pairing is listening; do not substitute an
unmonitored, agent-written polling script.

For marketplace rescue, run the installed package's `bridge.js` directly, or
pass its installed root explicitly when using a source checkout:

```sh
bun run bridge pair-confirm NAME --session SESSION_ID --code PAIRING_CODE --plugin-root PLUGIN_ROOT
bun run bridge resume NAME --plugin-root PLUGIN_ROOT
```

The root must contain the Telegram manifests, launcher and bundled runtime. This
path does not require `manager-installation.json`. If the package cannot be
resolved, pairing is retained and the result includes `plugin_identity_unavailable`
with recovery instructions. Other activation errors are recorded privately as
`pairing_activation_error`; the Telegram notice makes clear that the receiver
is not yet ready. `mcp-startup-failed` identifies failed initialization; `mcp-unavailable` means
its tools are unavailable without a confirmed startup failure. Inspect
`mcpServerStatus/list` before requesting a configuration refresh. Reloading the
conversation is not a confirmed fix for a broken launcher. Loading tools and
actual round-trip delivery still require separate checks; never reload active
work to force activation.

## Receiver lifecycle

Codex owns every supported receiver through MCP. There is no detached receiver,
`run` command, supervisor command or session-hook launcher. Do not use a second
poller to work around MCP startup failures; inspect the actual startup error.
Connecting an existing independently configured bot through the plugin stops its
old owned process before attaching MCP. Pairing, session ownership, cursors and
receipts remain intact. Direct starts of unmigrated configurations fail without
launching a process. Retired process cleanup remains available for migration.

## Runtime reference

See [runtime internals](runtime.md) for ownership, pairing, command dispatch,
rendering, token accounting, tool activity, questions and delivery recovery.
For the user-facing behavior, see [Using Telegram](usage.md).

## Local state

Default root: `~/.local/share/codex-telegram`; `--data-dir` overrides it.

| Path | Contents |
| --- | --- |
| `instances/NAME/config.json`, `credential.json` | Binding and credentials |
| `instances/NAME/delivery.sqlite3` | Inbox, cursor, metadata, delivery receipts |
| `instances/NAME/inbox`, `outgoing` | Received and sendable attachments |
| `instances/NAME/health.json`, `worker-process.json` | Health and ownership |
| `manager-installation.json` | Shared installation receipt |
| `pairings/NAME.json` | Temporary pairing proof and credentials |
| `plugins`, `runtimes`, `locks` | Plugin sources, bundles, receiver coordination |

State files are private. Codex manages installed plugin files in its own cache.
Keep secrets out of messages and commits.

## Integration probes

Read probes before running them: they create temporary plugins and sessions, and
some may run a model turn. Telegram is stubbed; they send no Telegram messages.

- `scripts/probe-bun-install.ts` — installation, reinstall, cleanup, and retained settings.
- `scripts/probe-slash-commands.ts` — real App Server settings and discovery in an isolated thread, without model turns or Telegram requests.
- `scripts/probe-telemetry.ts` — two short real model turns and one compaction in a disposable thread; checks token footers and compaction notices with Telegram stubbed.
- `scripts/probe-first-load.ts` — first installation and reload of a disposable session.
- `scripts/probe-channel.ts`, `scripts/probe-channel-migration.ts` — shared plugin behavior.
- `scripts/probe-mcp-lifecycle.ts`, `scripts/probe-mcp-plugin.ts` — legacy lifecycle behavior.

## Existing-session update probe

`probe-marketplace.ts --upgrade` uses an isolated Git marketplace with a local
URL rewrite, two package versions, and a real Codex App Server. It runs the
bundled CLI updater over the real Unix transport, queries the running version
before and after, and verifies that the MCP process changes while the same thread remains open. It uses no
model turns or Telegram requests and does not touch the active installation.
The disposable conversation contains injected fixture history, so subscription
retention is tested against a persisted, resumable thread.

`bun/update.ts` keeps already-loaded threads subscribed during installation and
MCP refresh. It never loads an inactive conversation. Success requires the
installed version to match `plugin_status`; configured active receivers must
also report that version, the current MCP PID, completed Codex attachment and
working Telegram polling. Paused bots stay paused. Unconfirmed activation is
reported separately, with no automatic session archive, reopen or independent
receiver. Only the explicit concurrent marketplace auto-refresh conflict is
retried; install calls and ambiguous message deliveries are never replayed.

### Activation protocol

The foreground CLI uses `plugin/reconcile` followed by
`config/mcpServer/reload` with `params: null`. These are App Server RPCs, not
shell commands or TUI slash commands. Codex CLI 0.163.0 exposes no
`codex mcp reload`; `/mcp` is a status query. An accepted refresh is followed by
`mcpServer/tool/call` for `plugin_status` in each held thread. Matching versions
and current receiver health are required before reporting success.

The installed CLI is `bun <installedPath>/bridge.js update`; `installedPath` is
returned by `codex plugin add codex-telegram-mcp@fty1777 --json`. Developers with
a checkout may use `bun run bridge update`. The latter is not a prerequisite for
marketplace users. The updater starts with v0.7.7 and cannot be invoked from an
older bundle that does not contain it.
