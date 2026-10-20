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
| Codex cannot find the Telegram tools | Finish the current task, then reload the same conversation. |
| The bot does not send a pairing code | Check that setup is open and that you sent `/start` in a private chat. Ask Codex to check pairing. |
| The code expired | Ask Codex to cancel the expired setup and open a new pairing window. |
| Pairing succeeded, but messages do not arrive | Ask Codex to check the connection. Pairing usually does not need to be repeated. |
| The bot is already connected elsewhere | Ask Codex to move the existing bot to this conversation. |

Reloading tools does not require reinstalling the plugin or creating another bot.
Avoid reloading a conversation while Codex is working.

## Add or move a bot

To add another bot, ask Codex to connect it with a different name.

To move an existing bot, open the destination Codex conversation and ask Codex to
move it there. Messages waiting in the previous conversation stay there. A paused
bot stays paused unless you ask to activate it.

## An existing Telegram integration

If the same bot is used by another service, stop that service before connecting it
here. Ask Codex to check the setup if it reports that the bot is already in use.

If you previously installed this project using `bun run bridge install`, finish
the current task, then run `bun run bridge uninstall-plugin` from that checkout
before switching to the marketplace installation. Bot settings and pairing are
retained. After loading the marketplace tools, ask Codex to inspect your bots and
bind the existing bot to the intended conversation. No new bot or pairing is needed.

For terminal commands and troubleshooting details, see the
[developer reference](development.md#setup-and-recovery-reference).
