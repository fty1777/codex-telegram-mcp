# Codex Telegram MCP

Continue your Codex conversation from Telegram. Send messages, photos, and files;
get progress updates and replies in the same chat. Your terminal and Telegram use
the same Codex session.

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

System notices appear as quotes with a **System** heading inside. Codex messages end with elapsed time:
`(Codex Working 12s)` for progress and `(Codex Worked 1m 20s)` for final replies.

Replies support text formatting.

| Command | Action |
| --- | --- |
| `/help` | Show commands |
| `/status` | Check the connection and session |
| `/stop` | Interrupt the current task |
| `/queue` | Check queued messages |
| `/approve CODE`, `/deny CODE` | Respond to an approval request |
| `/answer CODE QUESTION ANSWER` | Answer a pending question |

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
