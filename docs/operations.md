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

The updater and `update-telegram` skill are new in v0.7.7. They are not included
in v0.7.6 or earlier. Installing files and activating them in an open conversation
are separate steps.

### Ask Codex to update

In the conversation using Telegram, say:

> Update the Telegram plugin and verify that the new version is running.

With v0.7.7 or later, Codex can use the bundled `update-telegram` skill. It runs
the installed updater, refreshes MCP in the existing conversation, and checks the
running version and receiver readiness. No repository checkout is needed.

### Update manually from a terminal

Refresh the marketplace and install the package, requesting its installed path:

```sh
codex plugin marketplace upgrade fty1777
codex plugin add codex-telegram-mcp@fty1777 --json
```

These commands alone do not confirm that an open conversation is running the new
version. Find `installedPath` in the second command's JSON output. If the package
is v0.7.7 or later, run its updater, replacing `<installedPath>` with that value:

```sh
bun "<installedPath>/bridge.js" update
```

Run this while the intended Codex conversation is open. The updater performs the
marketplace/install checks again, keeps loaded bot conversations subscribed
while MCP is replaced, and verifies activation. It does not start a model turn.
Paused bots stay paused; conversations that are not loaded are left unopened.

If the installed package is still v0.7.6 or earlier, it has no `update` command.
Return to Codex and ask it to refresh the Telegram MCP connection and verify the
running version and receiving. Older versions also lack `plugin_status`, so file
installation alone must not be reported as verified activation.

Codex CLI 0.163.0 has no `codex mcp reload` command, and `/mcp` displays status
rather than refreshing it. The updater uses the App Server API internally; there
is no additional native refresh command to paste into Codex.

### Check the result

| Updater result | Meaning |
| --- | --- |
| `updated` | The installed version is running in the checked sessions; active bot receivers are ready. |
| `up_to_date` | The desired version was already running and readiness was checked. |
| `installed` | Files are installed, but no loaded session was available to verify. |
| `awaiting_session` | Some configured conversations are not loaded; their activation is not verified. |
| `activation_pending` | Files are installed, but runtime version or receiver readiness remains unconfirmed. |

For an unconfirmed result, ask Codex to inspect `plugin_status` and `list_bots`.
Do not repeatedly reinstall or automatically reopen the active conversation.
Pairing, queued messages and delivery receipts are retained. Updates can cause a
brief reconnection. Receiver readiness is separate from a verified Telegram
message exchange; finish by sending a short message and checking the reply.
Keep `bun` on your PATH.

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
