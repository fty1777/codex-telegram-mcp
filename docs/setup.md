# Setup and recovery

[Back to the README](../README.md)

## Connect your bot

Use Linux with Bun and a signed-in Codex installation. Create a bot with
[@BotFather](https://t.me/BotFather), then follow the [setup steps](../README.md#get-started).
Keep the bot token private.

The marketplace plugin includes its runtime; you do not need a checkout or a
separate dependency installation. Bun must be available to Codex as `bun`.

In the Codex conversation you want to use, ask Codex to connect the bot. Send
`/start` privately to the bot, then paste its pairing code back into Codex.
Click the code to copy it. It expires after 15 minutes. Finish by sending a short Telegram message
and checking that Codex replies.

After pairing, only your private messages are accepted; other users and group
chats are ignored. See [privacy and disclaimer](privacy.md).

## If setup gets stuck

| What happens | What to do |
| --- | --- |
| `bun` is not found | Restart your shell after installing Bun, or use `~/.bun/bin/bun`. |
| `doctor` cannot connect | Open Codex and ask it to check the local connection before continuing setup. |
| Codex cannot find the Telegram tools | Ask Codex to inspect MCP startup status and refresh configuration. If a reload is still needed, finish the task first and reopen the same conversation. |
| The bot does not send a pairing code | Check that setup is open and that you sent `/start` in a private chat. Ask Codex to check pairing. |
| Pairing has a candidate, but no code arrived | Ask Codex to check code delivery status; a candidate alone does not confirm delivery. Do not blindly resend an unknown delivery. |
| The code expired | Ask Codex to cancel the expired setup and open a new pairing window. |
| Pairing succeeded, but messages do not arrive | Ask Codex to check the connection. Pairing usually does not need to be repeated. |
| The bot is already connected elsewhere | Ask Codex to move the existing bot to this conversation. |

First installation into an already open conversation differs from updating an
existing working installation. Codex may not expose newly installed tools in
that conversation. Check startup status first; if a conversation reload is still
needed, finish the current task before reopening the same conversation. A new
bot, repeated pairing and a repository checkout are not required.

For an existing installation, follow [Updates](operations.md#updates), including
the activation check after a manual file update. `/mcp` alone does not activate
an updated package.

## Add or move a bot

To add another bot, ask Codex to connect it with a different name.

To move an existing bot, open the destination Codex conversation and ask Codex to
move it there. Messages waiting in the previous conversation stay there. A paused
bot stays paused unless you ask to activate it.

## An existing Telegram integration

If the same bot is used by another service, stop that service before connecting it
here. Ask Codex to check the setup if it reports that the bot is already in use.

When moving from an older checkout-managed installation, keep it installed and
enabled while installing the marketplace package. Ask Codex to verify that the
new plugin's tools are callable in the intended conversation before switching
the existing bot. Installation or a successful configuration refresh alone does
not prove that the new MCP is ready.

The handoff preserves pairing and the bound conversation, stops the old poller
before starting the replacement, and checks fresh receiver health. If the target
MCP is unavailable, leave the old binding in place. Do not uninstall the old
plugin first or create a new bot. If this already happened, ask Codex to inspect
the saved binding and recovery state; the official foreground send command can
provide a progress notice while normal receiving is down.

Some Codex versions cannot expose a newly installed MCP in an already open
conversation. Inspect startup status and try a configuration refresh first. If
it remains unavailable, finish current work before considering reopening the
same conversation; this is not a confirmed universal fix. Verify receiving and
a normal reply before removing a superseded installation. Remove only the old
plugin/catalog entry; per-bot uninstall commands stop or remove the current bot.

See [architecture and lifecycles](architecture.md) for the distinction between
same-identity updates and changing plugin identity. The new handoff readiness
checks are introduced in v0.7.7; older releases do not provide these safeguards.

For terminal commands and troubleshooting details, see the
[developer reference](development.md#setup-and-recovery-reference).
