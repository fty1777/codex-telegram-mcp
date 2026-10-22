---
name: update-telegram
description: Update the installed Codex Telegram MCP plugin and verify that the running version and receiver recover in the existing session. Use when the user asks to update this integration.
---

Let in-flight Telegram tool calls finish, then run the bundled updater in the
foreground:

```sh
bun "<plugin-root>/bridge.js" update --session "<current-codex-thread-id>"
```

Resolve `<plugin-root>` as two directories above this skill's directory, using
its actual installed location. Use the current Codex thread ID; if unavailable,
omit `--session` and report which configured sessions the updater verified.
For a source checkout, `bun run bridge update` runs the same updater.

The updater refreshes the marketplace, installs the current release, keeps loaded
sessions subscribed, refreshes MCP and checks the actual runtime version and
receiver health. It does not start a model turn or replace the conversation.

Report `updated` or `up_to_date` only when returned by the updater. `installed`,
`awaiting_session` and `activation_pending` do not prove a running update. If
activation remains pending, inspect `plugin_status` and `list_bots`; do not loop
reinstallation or reopen/archive the active session. Preserve pairing and unknown
delivery receipts. Receiver readiness is separate from verified Telegram delivery.
