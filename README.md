> **Disclaimer: This is an independent community project, not affiliated with or**
> **endorsed by OpenAI, Anthropic or Telegram. Provided as is, without warranty.**
> **Messages and files pass through Telegram and your configured Codex/model services.**
> **You are responsible for protecting your bot token and deciding what to share and**
> **which actions to authorize. See [privacy and disclaimer](docs/privacy.md).**

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

Send messages, photos, and files; get formatted replies and live progress updates.
Your terminal and Telegram share the **same Codex session**. After pairing, the bot
accepts only your private messages.

## Get started

You need Linux, [Bun](https://bun.sh) on your PATH, Codex CLI with plugin support
installed and signed in, and a Telegram
bot token from [@BotFather](https://t.me/BotFather) (`/newbot`).

Install the plugin:

```sh
codex plugin marketplace add fty1777/codex-telegram-mcp
codex plugin add codex-telegram-mcp@fty1777
```

Then, in the Codex conversation you want to use:

1. Ask Codex to connect your bot using its token.
2. Send `/start` privately to your bot.
3. Paste the pairing code back into that Codex conversation.
4. Send a short Telegram message and check that Codex replies.

If the tools are not available yet, see [setup and recovery](docs/setup.md).

## File limits

Telegram documents these limits for the file transfers used by this integration:

| Transfer | Maximum file size |
| --- | --- |
| Telegram → Codex | 20 MB |
| Codex → Telegram, sent as a file | 50 MB |
| Codex → Telegram, sent as a photo | 10 MB |

Sources: Telegram's [file download limits](https://core.telegram.org/bots/api#getfile)
and [file upload limits](https://core.telegram.org/bots/api#sending-files).

## Documentation

- [Using Telegram](docs/usage.md) — replies, tool activity, status footer and questions.
- [Commands](docs/commands.md) — slash commands and examples; also available with `/help`.
- [Setup and recovery](docs/setup.md) — pairing and connection problems.
- [Manage your connection](docs/operations.md) — updates, pause, move and removal.
- [Development](docs/development.md) — build, tests and architecture.

## Acknowledgements

Thank you to [ssamssae/codex-telegram-bridge](https://github.com/ssamssae/codex-telegram-bridge),
the starting point for this project, and to the
[Claude Code Telegram channel](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram),
from which we ported and adapted many features.

## License

[Apache-2.0](LICENSE) · [Third-party notices](NOTICE) · [Privacy and disclaimer](docs/privacy.md)
