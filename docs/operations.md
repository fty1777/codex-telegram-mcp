# Manage your Telegram connection

[Back to the README](../README.md)

Ask Codex to check, pause, resume, move, or remove a bot. Each bot can be managed
separately.

## Check the connection

Send `/status` to your bot, or ask Codex to check it. A successful setup ends with
a Telegram message reaching Codex and a reply arriving back in Telegram.
Being able to send a message or photo alone does not confirm receiving works.
When reconnecting, history is restored in the background while new messages can
still be received. Ask Codex to check the last received message and recovery state
if messages appear delayed.

For message formatting, status footers and questions, see [Using Telegram](usage.md).

## Pause or stop

Ask Codex to pause Telegram when you want to stop receiving messages, and to resume
it when you are ready. This leaves your bot and pairing saved.

`/stop` interrupts the current Codex task. It keeps the Telegram connection open.
To stop receiving altogether, ask Codex to pause or disconnect Telegram. Closing
one terminal may leave the connection running.

## Updates

For a marketplace installation, run:

```sh
codex plugin marketplace upgrade fty1777
codex plugin add codex-telegram-mcp@fty1777
```

Existing bots and pairing are retained. A brief reconnection can occur during an
update. Keep `bun` on your PATH. If new tools do not appear, finish the current
task, then reload the conversation.

## Remove a bot or the plugin

Ask Codex to remove a bot when you no longer want to use it here. Removing a bot
clears its local settings and history. It does not delete the bot on Telegram or
affect other configured bots.

Removing the plugin disconnects all bots while retaining their settings for later
reinstallation. Your Codex conversations and projects are preserved.

```sh
codex plugin remove codex-telegram-mcp@fty1777
codex plugin marketplace remove fty1777
```

## Terminal commands

Run these from the checkout. Replace `default` with your bot's configured name.

```sh
bun run bridge list
bun run bridge doctor --instance default
bun run bridge pause --instance default
bun run bridge resume --instance default
bun run bridge unbind default
bun run bridge uninstall default --keep-config
bun run bridge uninstall default
```

`unbind` keeps the bot paired so it can be connected to another conversation.
`uninstall --keep-config` keeps its settings and history in a paused state.
For full removal, uninstall each bot before uninstalling the plugin.
The checkout command `bun run bridge uninstall-plugin` removes only the older
checkout-based installation; use `codex plugin remove` for the marketplace plugin.

For system notices and uncertain delivery, see [Using Telegram](usage.md#system-notices).
