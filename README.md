<div align="center">
  <img src="assets/logo.png" alt="Codex Telegram MCP logo" width="160" />
  <h1>Codex Telegram MCP</h1>
  <p>Continue your Codex conversation from Telegram.</p>
  <p>
    <a href="https://github.com/fty1777/codex-telegram-mcp/actions/workflows/check.yml"><img src="https://github.com/fty1777/codex-telegram-mcp/actions/workflows/check.yml/badge.svg?branch=main" alt="Checks" /></a>
    <a href="https://github.com/fty1777/codex-telegram-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/fty1777/codex-telegram-mcp?color=229ED9" alt="Latest release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" /></a>
    <img src="https://img.shields.io/badge/platform-Linux-555" alt="Platform: Linux" />
  </p>
  <p>
    <a href="#get-started">Get started</a> ·
    <a href="docs/commands.md">Commands</a> ·
    <a href="docs/setup.md">Setup &amp; recovery</a>
  </p>
</div>

Send messages, photos, and files; get progress updates and replies in the same
chat. Your terminal and Telegram use the **same Codex session**.

| Stay connected | Stay informed | Stay in control |
| --- | --- | --- |
| Continue from your phone | Formatted replies and live tool activity | Shared CLI commands and settings |
| Send photos and files | Token usage, context and goal status | Answer questions and approve actions |

## File limits

Telegram documents these limits for the file transfers used by this integration:

| Transfer | Maximum file size |
| --- | --- |
| Telegram → Codex | 20 MB |
| Codex → Telegram, sent as a file | 50 MB |
| Codex → Telegram, sent as a photo | 10 MB |

Sources: Telegram's [file download limits](https://core.telegram.org/bots/api#getfile)
and [file upload limits](https://core.telegram.org/bots/api#sending-files).

## Get started

You need Linux, [Bun](https://bun.sh) on your PATH, Codex CLI with plugin support
installed and signed in, and a Telegram
bot token from [@BotFather](https://t.me/BotFather) (`/newbot`).

Install the plugin:

```sh
codex plugin marketplace add fty1777/codex-telegram-mcp
codex plugin add telegram@codex-telegram
```

Then, in the Codex conversation you want to use:

1. Ask Codex to connect your bot using its token.
2. Send `/start` privately to your bot.
3. Paste the pairing code back into that Codex conversation.
4. Send a short Telegram message and check that Codex replies.

If the plugin was installed during an open conversation, finish the current task,
then reload that same conversation to load its tools. You do not need to install
again or pair again. See [setup and recovery](docs/setup.md) if you get stuck.

## Use it

Send messages, photos, and files to Codex through your bot. The paired bot accepts
only your private messages.

Replies support formatting, live tool activity, and a status footer showing elapsed
time, token usage, context usage, model and goal state when available. Context
compaction has a timed system notice; messages received during compaction wait in
the queue.

Use `/activity keep`, `/activity off`, or `/activity transient` (default) to choose
whether tool details remain after a task. Use `/questions` to find questions
awaiting your reply, without using model tokens.

<details>
<summary>Reading the status footer</summary>

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
messages. System notices use a quote with a **System** heading.

</details>

Send `/help` for commands or `/help goal` for usage and examples. Help is returned
directly without invoking a model. See the [command reference](docs/commands.md)
for all supported commands, including model settings, planning, and code review.

| Command | Action |
| --- | --- |
| `/help` | Show commands |
| `/status` | Check the connection and session |
| `/goal` | Show the current goal |
| `/goal OBJECTIVE`, `/goal edit OBJECTIVE` | Set or change the goal |
| `/goal pause`, `/goal resume`, `/goal clear` | Pause, resume, or remove the goal |
| `/compact` | Compact conversation history |
| `/rename NAME` | Rename the session |
| `/stop` | Interrupt the current task |
| `/queue` | Check queued messages |
| `/approve CODE`, `/deny CODE` | Respond to an approval request |
| `/questions` | List unanswered questions and reply commands |
| `/answer CODE QUESTION ANSWER` | Answer a pending question |

Goals, model settings, planning mode, permissions, and session names are shared
with Codex CLI. Commands run directly on the connected session.

## More details

- [Setup and recovery](docs/setup.md) — pairing, reloading tools, multiple bots, rescue commands.
- [Operations](docs/operations.md) — pause, move, upgrade, uninstall, and local state.
- [Development](docs/development.md) — tests, architecture, formatting, and integration probes.

## Acknowledgements

Thank you to [ssamssae/codex-telegram-bridge](https://github.com/ssamssae/codex-telegram-bridge),
the starting point for this project, and to the
[Claude Code Telegram channel](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram),
from which we ported and adapted many features.

## License and disclaimer

Licensed under [Apache-2.0](LICENSE), with upstream notices in [NOTICE](NOTICE).

This is an independent community project, not affiliated with or endorsed by
OpenAI, Anthropic, or Telegram. It is provided as is, without warranty, under the
terms of the license. Messages and files pass through Telegram and your configured
Codex/model services. You are responsible for protecting your bot token and
deciding what to share and which actions to authorize.
