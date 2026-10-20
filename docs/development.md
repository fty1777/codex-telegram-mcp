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
`telegram@codex-telegram`. Its package lives in `plugins/telegram/` and uses the
Codex compatibility manifest and `${PLUGIN_ROOT}` paths. The `plugin` CLI entry
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
```

The build copies license notices and gathers licenses for bundled dependencies.
Commit the generated `plugins/telegram/` files with their source changes. Keep
`package.json` and the generated plugin version in sync; bump the version for a
release. Publish only the intended branch and release files, never local archive
branches or private runtime state.

The marketplace probe copies only the distributable package into a temporary
catalog, installs it with an isolated `CODEX_HOME`, loads its MCP tools, and checks
that removal closes the host. It creates no Codex sessions and makes no Telegram
requests. Pairing, receiver readiness, and real round-trip delivery need separate
checks; package installation alone does not establish them.

For source-checkout development, the existing `bun run bridge install` installer
remains available. Remove that installation before migrating to the marketplace
plugin, as described in [setup](setup.md#an-existing-telegram-integration).

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
bun run bridge pair-confirm NAME --session SESSION_ID --code PAIRING_CODE
bun run bridge pair-cancel NAME --session SESSION_ID
bun run bridge bind NAME --session SESSION_ID --activate
```

Keep the token file private. `pair-confirm` saves pairing, attempts receiver startup,
and journals the same acknowledgement as the native tool. A startup failure leaves
pairing saved; inspect state before retrying activation. Expired or exhausted
pairing windows must be cancelled before replacement.

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
