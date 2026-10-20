# Runtime internals

[Development](development.md) · [README](../README.md)

## Status fields

Report plugin installation, tool loading, pairing, receiver connection, and a
successful message exchange separately. `awaiting-session` means the bound session
must be resumed. `mcp-startup-failed` identifies initialization failure, while
`mcp-unavailable` means its tools are unavailable without a confirmed startup
failure. Inspect MCP startup status before choosing a recovery action; a
successful refresh request alone does not prove recovery.

`list_bots` exposes current `receiver_status` and a historical pairing check:

| `pairing_connectivity` | Evidence |
| --- | --- |
| `not_tested` | No `pairing-success` receipt |
| `outbound_unconfirmed` | A receipt exists without confirmed delivery |
| `awaiting_owner_reply` | Acknowledgement sent; no later accepted owner message |
| `verified` | Acknowledgement sent and a later owner message accepted by Codex |

An older bot can work without that historical check. Use receiver health to assess
the current connection.

## Large sessions and receiver progress

Attachment resumes metadata only and queries the latest turn with
`thread/turns/list` (`itemsView: notLoaded`). History recovery uses ascending,
full-item pages of one turn, preserving existing delivery receipts and allowing
cancellation between pages. It does not hydrate the entire thread on servers
with pagination. Only an explicit method-not-supported response permits the
legacy full-history fallback; transport failures never trigger that fallback.
A single exceptionally large turn can still exceed the response limit.

The App Server response limit defaults to 256 MiB. Set
`CODEX_TELEGRAM_MAX_PAYLOAD_MIB` in the MCP process environment to an integer
between 1 and 512 to change it. The transport checks decoded message size before
JSON parsing as well as configuring the WebSocket limit. The decoded check also
covers Bun versions whose WebSocket implementation ignores `maxPayload`; it does
not prevent those versions from buffering the incoming frame. Oversized responses
retain the RPC method and transport error code in private diagnostics.

Receiver readiness remains `starting` until attachment completes, even if
Telegram polling already works. Health includes the current pipeline operation,
its start time and the last progress time. Stalled operations cancel their
transports before the MCP owner retries. Output backlog is drained in bounded
time slices so it cannot indefinitely postpone accepted incoming messages.

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

The MCP host and rescue `pair-watch` share a cancellable, time-bounded watcher.
Transient reads retry with backoff; authentication and poll conflicts stop with
a queryable reason. Pairing summaries expose read health and per-candidate code
delivery status without user IDs, codes or credentials. Code sends reserve their
candidate and cursor before network I/O; ambiguous sends remain unknown and are
never replayed. Pairing activation failures preserve the binding, record a
redacted local diagnostic, and produce a readiness-aware system notice.

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

`bun/rich.ts` renders safe, allowlisted Rich Message HTML. New text sends use
`sendRichMessage`; edits use `editMessageText` with `rich_message`. Rich Messages
preserve native headings, dividers, tables (up to 20 columns), lists, and nested
quotes. Model-authored HTML stays literal and links are scheme-checked. Plain
messages and oversized bodies use balanced entity-to-HTML rendering; attachment
captions retain ordinary `caption_entities` and their separate size limit.
System notices are quotes with a bold System heading. Codex adds no heading;
its statusline uses a native footer. Elapsed time uses persisted
server turn timestamps; no duration is shown when timing is unavailable. Footers
also include reported token counts. `thread/tokenUsage/updated` cumulative totals
are differenced against the observed preceding turn's total; `last` is one model
request and must never be mistaken for a whole turn. Counts include reported
input and output, including cached input; they are not price estimates. Input,
cached input, and output are also differenced individually and displayed as
`↑N cN ↓N`. The displayed `↑` is input minus cached input, computed before
rounding; `c` is cached input and `↓` is output. Stored snapshots retain total
input so both turn and session calculations use the same reported fields. Components are omitted if their matching baseline is unavailable (for
example, the first turn after upgrading an older journal) or a component resets.
Session components are never mixed with turn components. Counts use `k` with one
decimal (1k = 1000 tokens). Individual session counts switch to `m` at 1,000,000
tokens (1m = 1000k); session input/cache/output is appended separately when reported. Its total is
only shown as a fallback when that breakdown is unavailable. Session components do not require a
turn baseline. When a turn baseline is unknown, only session statistics are shown. No token
counter is shown before a valid usage snapshot is available. Connection changes
invalidate stale snapshots and the shared checkpoint, while preserving known
baselines for a turn that remains active. Counter resets discard its baseline.

Automatic final items observed during an active turn are journaled until
`turn/completed`, so usage arriving after the final text is included. Recovery can
flush pending finals without replaying delivered or ambiguous sends. Explicit
tool sends and progress use the latest reported usage available when sent.
Before an active turn's first usage update, progress may show the last known
session checkpoint alone. It never presents zero as measured turn usage; a
connection gap invalidates that checkpoint as usual.
Footers appear only on the final part of a split message, outside quoted content.
Context uses the latest request's `last.totalTokens` and `modelContextWindow`,
independent of cumulative session counts. `ctx USEDk/WINDOWk PERCENT%` follows
CLI 0.163's percentage calculation (12k baseline discounted), clamps to 0–100,
and is omitted when the window or last usage is unavailable. Compaction may
reduce context size without reducing cumulative usage. Reconnect generation
guards also apply to context snapshots.

Both Working and Worked statuslines use native `<footer>` blocks. Goal status
comes from an initial `thread/goal/get`, goal update/clear notifications and
successful goal commands. Pending question counts include unanswered async/form
fields and live blocking input requests. Absent goals and zero counts are omitted.
`/questions` returns the pending inventory without model work; request IDs and
complete answer commands use native copy-text buttons. Cross-client question replies resolve
only their matching source-item/question-index identities.
The worker renders tool activity and the Working footer together and edits the
latest progress message immediately when tool content changes; footer-only changes
refresh every 10 seconds. A newly arrived
progress message retires earlier Working footers immediately. Tool items are anchored
to the message present when they start; completion edits that same message even
after newer progress arrives. The original final message part and
its body entities are retained, so multipart boundaries and body formatting stay
unchanged. Retired progress messages receive tool changes without a Working footer;
final answers are not refreshed. Completed
turns, manual edits, pairing/binding changes and paused instances stop updates.
Each Working tail retains its original body and entities. On completion all known
tails for that turn are queued for edits that remove only their footers. Cleanup
runs independently of counter refreshes, at most once per second while the finite
cleanup queue drains. It survives reconnects, honors shared 429 retry_after, and
never edits final answers or deletes messages. Ambiguous cleanup is not replayed;
manual edits opt that message out of cleanup.
Reported tokens advance on Codex usage events; elapsed time can advance between
events. Reconnect gaps retain existing counters until a fresh snapshot arrives.
Each edit reserves its own durable receipt before sending. Unknown counter versions are never replayed. A strictly newer rendered version
may replace the same confirmed message; this does not create a new message.
Terminal edit rejections suspend that target. Known 429 responses honor retry_after
across later progress messages, and not-modified responses are harmless. Refresh
failures stay in local diagnostics. Oversized edits stop instead of truncating the
body. The 10-second interval is a minimum between periodic refresh requests; network delay and
Telegram backoff can make it longer.

Rich Message text is capped at 32,768 characters; the implementation uses the
stricter UTF-16 length when splitting to preserve surrogate pairs. A conservative
block budget keeps generated HTML below 500 blocks; native rendering bounds
nesting below 16 levels. Very large structures fall back to readable balanced
chunks rather than dropping text. Captions remain limited to 1024 UTF-16 units.
Oversized edits and captions fail before network I/O. Native body HTML is saved
with working targets so counter edits and footer cleanup retain body formatting.
Raw and v1 presentation receipts are recognized before v2 Rich Message receipts;
upgrading never replays a confirmed, rejected, or ambiguous send.

All text sends and edits share Telegram's flood-control deadline. A 429
response updates the shared deadline without shortening an existing wait; new
sends are journaled in a deferred outbox instead of calling Telegram during the
wait. After the deadline, known rejections retry under durable attempt IDs and
update the original request receipt. Ambiguous and partially delivered requests
are never retried. Binding changes discard deferred deliveries to the old owner.
Typing indicators also pause during flood control.

Reserve receipts before network I/O. Multipart sends also journal each part and
return `message_ids`; single sends return `message_id`. Partial or ambiguous sends
are never automatically replayed. Retrying the same request ID returns its recorded
outcome. Recognize legacy fingerprints and chunk boundaries during recovery.

## Diagnostics and lifecycle

Live `contextCompaction` item starts and completions produce quoted system notices.
Start times and notice reservations persist; confirmed completion can include
elapsed time. The confirmed start notice is edited with a running timer using
the same 10-second request budget and 429 backoff as progress edits. Completion
stops the timer and replaces its running text. Deprecated `thread/compacted` notifications share the completion
reservation. Recovered historical compactions stay silent; a previously observed
start can receive its missed completion notice without inventing a finish time.
Repeated events and ambiguous delivery are never retried under another event ID.

Keep intermediate tool failures and nonzero shell exits local. The journal stores
the latest redacted tool error as `last_tool_error`. Codex interprets results and
communicates actionable blockers. Automatic reconnection retries stay silent in Telegram; errors remain in local
diagnostics and connection status. Actionable notices, such as a conflicting
bot connection that stops receiving, remain visible.

A new receiver waits up to five seconds for the outgoing receiver's lock. Continued
contention retries quietly while a live receiver has a connected heartbeat less
than 15 seconds old. Cancellation and binding changes abort startup. Unexpected
failures retry within the MCP host; a Telegram polling conflict stops receiving.

Archive/close, MCP EOF, and plugin removal stop the owned receiver. Registration
checks revoke disabled or stale plugin processes. Temporary App Server disconnects
reconnect to the existing session. Stop/pause disables automatic receiving until
start/resume; pause also disables the instance. Legacy upgrades preserve rollback
snapshots for previous registration and hook settings.

## Tool activity and questions

Tool activity (`bun/activity.ts`) observes live tool item lifecycle events and
retains all structural summaries alongside the live Working footer. Tool ownership is fixed at item start, including across steered inputs. If no progress exists yet it creates one temporary
status message. There is no fixed item or action count limit. Long histories
continue in tracked messages within Telegram's length limit; continuation sends
never take over the current counter. They share the Telegram backoff and transient
cleanup. Tool summaries use monospace throughout, including bold group labels and explicit HTML line breaks, omit blank lines between tool groups, and leave
no extra blank line before the Working footer. A single worker refresh renders
activity and counters together. Historical
recovery and reasoning are excluded. Consecutive reads, searches and file lists
are grouped as Explored/Exploring. Search details are bounded and redacted; paths
use basenames only. Commands show an allowlisted executable and bounded safe arguments
(e.g. bun run typecheck or tail -8 checks.log). Script bodies, environment
values, credential flags, quoted free text and additional shell commands are omitted. Arbitrary output remains hidden; the exact compiler invocation
`$ tsc --noEmit` can be shown for typecheck scripts. A normal nonzero shell exit does not
produce a warning. Telegram delivery tools are excluded. `/activity` configures
`transient` (default, delete on completion), `keep`, or `off` without invoking the
model. Tool-content changes update immediately in the next worker cycle, including the footer
in the same edit. Footer-only refreshes use a 10-second interval; all requests
honor the shared 429 backoff. Unknown or interrupted activity sends are not replayed. Transient
activity deletion uses the same durable cleanup queue as Working footer removal;
normal progress messages are edited to remove the footer, never deleted.


`bun/questions.ts` forwards asynchronous `agentMessage.questions` as soon as the
item completes, before normal final-message buffering. Active-turn recovery finds
missed questions without replaying deliveries. Codes and answer state are durable.
`/answer` turns async answers into an idempotently identified follow-up input via
turn/steer (or turn/start when idle); these questions are not JSON-RPC requests. Answers use Codex CLI 0.163's
`send_user_message_question_reply` envelope, with a JSON-encoded tool name, source
item ID, and zero-based question index, so the CLI can resolve each pending entry.
MCP form elicitations use their real server request IDs and typed structured
content instead. Single-choice enums, strings, booleans and numbers are supported;
unsupported and sensitive fields stay in Codex CLI. `/deny` declines forms.
Submitted or ambiguous answers are not replayed. Questions remain separate from
transient activity and survive its cleanup.

Queued Working commentary expires after one minute or when its turn ends, so recovery
does not deliver stale progress notices. Final replies retain durable deferred delivery.

Original inline code of 1–256 UTF-16 units becomes a native copy-text button
whose label and copied value are the original text. Blank-only or longer snippets
remain code; fenced code blocks and generated tool summaries retain monospace formatting.
Raw model-authored HTML remains escaped.

The footer shows the configured thread model and reasoning effort from resume/read
snapshots and thread/settings/updated notifications. Unknown settings are omitted.
Goal completion uses “Goal achieved”. Nonzero command exit codes replace the tool heading with “Failed (exit N) COMMAND”,
followed by “(no output)” when appropriate, without a system warning.

## Receiver recovery and exit diagnostics

Polling and command registration start before Codex attachment/history recovery.
`bun/recovery.ts` scans history through a separate, cancellable Engine and stages
outbound intents in durable `history_queue:*` records. A background delivery loop
drains those intents and rate-limit retries; neither slow historical HTTP nor a
blocked retry holds up foreground event or inbox processing. History commentary
is durable history, not expiring live progress. Original send request IDs and
legacy receipts are preserved; ambiguous results are blocked for inspection.
Each intent captures the owner, thread and binding revision, checked again by
Sender before dispatch. Binding changes never retarget old history.

Reconnection closes the old App Server client, cancels and joins its scan, then
creates the next Engine. Generation checks prevent concurrent scan starts. Worker
shutdown aborts HTTP, cancels recovery and joins background tasks before closing
journals or releasing receiver ownership. No routine recovery notifications are
sent to Telegram.

Health reports polling, recovery pending/blocked counts, last accepted inbound and
outbound delivery separately. `list_bots` exposes only their allowlisted summaries,
plus `last_exit`. `worker_exit` and timestamped journal records retain explicit
shutdown reasons: session lifecycle, host cancellation, signals, lease/binding
revocation, polling conflict or unexpected worker error. An old live health record
left behind after ownership was lost is recorded as `unclean_previous_exit`; this
means the precise cause is unknown, not a diagnosis of the old incident.

`tests-bun/recovery.test.ts` covers blocked historical sends with prompt owner input,
two-bot isolation, cancellation/replacement, stable receipts, flood backoff, binding
changes and diagnostic privacy. These are controlled local tests, not evidence of
Telegram delivery in an unrelated installation.


Receiver discovery verifies `worker-process.json` against the live process
identity before using its health. Retired independent process records cannot
report a running receiver. Only Codex-owned MCP workers can be started; old
independent receivers can be stopped for migration, never relaunched. Plugin
connection drains a retired receiver before attaching MCP, preserving pairing,
message cursors and delivery receipts. A worker-only ownership record is never
signalled as an independent process because it may belong to the Codex host.
