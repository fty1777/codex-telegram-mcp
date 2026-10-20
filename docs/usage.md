# Using Telegram

[README](../README.md) · [Commands](commands.md) · [Manage your connection](operations.md)

## Messages and replies

Send text, photos and files to your paired bot. It accepts only your private
messages; other users and group chats are silently ignored. File size limits are
listed in the [README](../README.md#file-limits).

Replies support formatting, live tool activity, and a status footer showing elapsed
time, token usage, context usage, model and goal state when available. 

Use `/activity keep`, `/activity off`, or `/activity transient` (default) to choose
whether tool details remain after a task. 

## Status footer

`Codex Worked 1m 20s · ↑2.0k c10.0k ↓0.3k · session ↑9.0k c90.0k ↓1.0k`

- `↑` is uncached input, `c` is cached input, and `↓` is output.
- Counts use `k` for thousands and `m` from one million, with one decimal.
- `session` shows session usage; a total is used if the breakdown is unavailable.
- `ctx 123.4k/258.4k 45%` shows context tokens, window size and used percentage.
- Model, reasoning effort, goal state and unanswered question count appear when available.

The Working timer refreshes every 10 seconds, subject to Telegram rate limits.
Tool-content changes update immediately in the same message. Working footers are
removed when a task ends; progress text and the final Worked footer remain.

Inline code up to 256 characters appears as a copy button; longer inline code and
code blocks keep code formatting. Long tool histories continue in additional
messages.

## Commands and questions

Send `/help` for the command list or `/help goal` for instructions and examples.
Help and `/questions` are answered directly without invoking a model. Use the
copyable reply commands shown with each question to answer it. Secret answers
must be entered in Codex CLI.

Goals, model settings, planning mode, permissions and session names are shared
with Codex CLI. See the [command reference](commands.md) for syntax and scope.
`/stop` interrupts the current task; it does not disconnect Telegram.

## System notices

System notices use a quote with a **System** heading and report connection changes or actions you need to take. Routine
tool failures do not produce warning messages. Context compaction updates one
timed notice from start to completion; messages received during compaction queue
for later processing.

If delivery cannot be confirmed, check the chat before repeating a request.
See [connection recovery](setup.md#if-setup-gets-stuck) for troubleshooting.
