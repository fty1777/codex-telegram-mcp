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
On Codex 0.162.1, MCP refresh alone did not reliably load the first installation;
archiving, unarchiving, and resuming an idle disposable conversation did. Never
archive production work in progress. Adding bots to an already loaded plugin does
not require this reload.

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

For private clones, check `git ls-remote`. A stale `GIT_ASKPASS` can invoke a missing
authentication helper; use a working configured credential helper when retrying.

## Status fields

Report plugin installation, tool loading, pairing, receiver connection, and a
successful message exchange separately. `awaiting-session` means the bound session
must be resumed; `awaiting-session-reload` means its new tools have not loaded.

`list_bots` exposes current `receiver_status` and a historical pairing check:

| `pairing_connectivity` | Evidence |
| --- | --- |
| `not_tested` | No `pairing-success` receipt |
| `outbound_unconfirmed` | A receipt exists without confirmed delivery |
| `awaiting_owner_reply` | Acknowledgement sent; no later accepted owner message |
| `verified` | Acknowledgement sent and a later owner message accepted by Codex |

An older bot can work without that historical check. Use receiver health to assess
the current connection.

## Ownership and pairing

One Codex-owned MCP host manages multiple independently bound bot receivers. Tool
metadata supplies the calling session identity. Sends and receiver control require
the bound session; binding changes use the observed `expected_session`. Each bot
also has an operating-system lock. New installations use no hooks or detached
supervisor.

Pairing is private, session-scoped, and expires after 15 minutes. Codes are hashed;
issuing one grants no access. Only private `/start` from a human receives a code,
at most once per user and for at most 20 users per window. Ten incorrect redemption
attempts exhaust the window. Successful redemption invalidates every code. Other
users and groups cannot submit messages or attachments.

Duplicate bots, concurrent pairing for the same bot, and existing webhooks are
refused. A session handoff pauses the old binding and holds its pending inbox;
receipts remain intact. Failed handoffs leave the old binding paused. Local account
access, credentials, and management tools remain trusted.

## Slash commands

Telegram slash commands are dispatched locally; they are never passed to a model
as plain prompts. `/goal` uses `thread/goal/get`, `thread/goal/set`, and
`thread/goal/clear` on the bound thread, with `origin: "user"` for explicit owner
mutations. `/goal edit OBJECTIVE` preserves the current status; pause and resume
omit the objective to preserve usage accounting and budget. Bare `/goal edit`
shows the goal and inline editing instructions rather than opening a terminal UI.
Objectives retain internal whitespace and are limited to 4,000 Unicode characters.

`/compact` uses `thread/compact/start` and refuses while a known turn is active;
the server remains authoritative about concurrent work. `/rename NAME` uses
`thread/name/set`. Unsupported methods produce an upgrade notice. Rejected commands
keep raw diagnostics in the private journal. Unknown outcomes and failed reply
delivery retain the inbound reservation and never automatically replay mutations.
The help text and Telegram menu share one command registry in `bun/commands.ts`.
`/help COMMAND` is handled without any App Server or model call. Other commands'
arguments are never intercepted as help: `/goal help` sets the objective to `help`,
and `/goal --help` sets the objective to `--help`. `build:plugin` also generates `docs/commands.md` from
that registry, and CI checks both the reference and bundle for freshness.

`bun/session-commands.ts` uses `thread/settings/update` for model, effort, service
tier, planning mode, and named permission profiles. Model and effort choices are
validated against the paginated model catalog; permission choices must be allowed
by the catalog resolved for the current working directory. Settings are owned by
Codex, without a second copy that could override terminal changes after reconnect.
Queued setting changes are observed with bounded reads, never repeated writes;
an unconfirmed change is described as requested. Fresh loaded sessions fall back
to `thread/read` when no rollout exists, and unknown settings stay unknown.

`/plan TASK` and `/skills NAME TASK` start native turns with stable message IDs.
`/review` uses `review/start` inline; `exitedReviewMode` results are forwarded with
the same delivery safeguards as public assistant messages. New-turn commands
refuse during active work. `/mcp`, `/skills`, `/plugins`, and `/ps` query inventories;
listings exclude private connection configuration and redact credentials. Query
timeouts return an information-unavailable notice, without suggesting a task was
submitted. The [command reference](commands.md) lists exact syntax and scope.
Other CLI commands, including terminal controls and session switching, are not
implemented and are never silently converted into model prompts.

See the official [slash command reference](https://developers.openai.com/codex/cli/slash-commands)
and [App Server goal API](https://developers.openai.com/codex/app-server#manage-a-thread-goal).

## Sending and formatting

Use stable `request_id` values for `send_text`, `edit_message`, `send_photo`, and
`send_document`. Place files in the `outgoing_directory` returned by `list_bots`.
Each shared tool takes `instance`. Tools accept `format=plain` for literal text and
`phase=commentary` for an explicit progress update. Public commentary and final
answers are also forwarded; identical explicit text suppresses duplicate forwarding.

`bun/format.ts` uses Marked tokens to produce text plus Bot API `entities` or
`caption_entities`. It never sends `parse_mode`. System notices are native quotes with a bold `System` heading inside each part;
Codex messages have no added headings. Progress and final text end with
`(Codex Working …)` and `(Codex Worked …)` respectively. Elapsed time uses persisted
server turn timestamps; no duration is shown when timing is unavailable. Footers
also include reported token counts. `thread/tokenUsage/updated` cumulative totals
are differenced against the observed preceding turn's total; `last` is one model
request and must never be mistaken for a whole turn. Counts include reported
input and output, including cached input; they are not price estimates. Input,
cached input, and output are also differenced individually and displayed as
`↑N (cN) ↓N`; cached input is a subset of input, not an additional
count. Components are omitted if their matching baseline is unavailable (for
example, the first turn after upgrading an older journal) or a component resets.
Session components are never mixed with turn components. Counts use `k` with one
decimal (1k = 1000 tokens). Individual session counts switch to `m` at 1,000,000
tokens (1m = 1000k); the session total and its input/cache/output breakdown
are always appended separately when reported. Session components do not require a
turn baseline. When a turn baseline is unknown, only session statistics are shown. No token
counter is shown before a valid usage snapshot is available. Connection changes
invalidate stale snapshots and the shared checkpoint, while preserving known
baselines for a turn that remains active. Counter resets discard its baseline.

Automatic final items observed during an active turn are journaled until
`turn/completed`, so usage arriving after the final text is included. Recovery can
flush pending finals without replaying delivered or ambiguous sends. Explicit
tool sends and progress use the latest reported usage available when sent.
Footers appear in italic only on the final part of a split message, outside quoted content.
Offsets and lengths use
UTF-16 units. Markdown quotes use native `blockquote` entities and retain inline
formatting. Nested quote levels are flattened into the outer quote. Incompatible
nested styles are removed or split; unsupported markup stays readable. Formatting is limited to 90 entities per message.

Render before splitting. Prefer line boundaries, preserve surrogate pairs, and
clip entities into each part. Edits must fit 4096 UTF-16 units and captions 1024,
including any timing footer; oversized edits and captions fail before sending.

Reserve receipts before network I/O. Multipart sends also journal each part and
return `message_ids`; single sends return `message_id`. Partial or ambiguous sends
are never automatically replayed. Retrying the same request ID returns its recorded
outcome. Recognize legacy fingerprints and chunk boundaries during recovery.

## Diagnostics and lifecycle

Live `contextCompaction` item starts and completions produce quoted system notices.
Start times and notice reservations persist; confirmed completion can include
elapsed time. Deprecated `thread/compacted` notifications share the completion
reservation. Recovered historical compactions stay silent; a previously observed
start can receive its missed completion notice without inventing a finish time.
Repeated events and ambiguous delivery are never retried under another event ID.

Keep intermediate tool failures and nonzero shell exits local. The journal stores
the latest redacted tool error as `last_tool_error`. Codex interprets results and
communicates actionable blockers. Reconnection notices use plain language and do
not expose internal exceptions.

A new receiver waits up to five seconds for the outgoing receiver's lock. Continued
contention retries quietly while a live receiver has a connected heartbeat less
than 15 seconds old. Cancellation and binding changes abort startup. Unexpected
failures retry within the MCP host; a Telegram polling conflict stops receiving.

Archive/close, MCP EOF, and plugin removal stop the owned receiver. Registration
checks revoke disabled or stale plugin processes. Temporary App Server disconnects
reconnect to the existing session. Stop/pause disables automatic receiving until
start/resume; pause also disables the instance. Legacy upgrades preserve rollback
snapshots for previous registration and hook settings.

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
