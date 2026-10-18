# Telegram commands

[Back to the README](../README.md)

Send `/help` or `/help COMMAND` to your bot for instructions without invoking a model.
Help is available through `/help COMMAND`; arguments to other commands retain their normal meaning.
For example, `/goal help` sets a goal whose objective is `help`. Commands use the same session as Codex CLI.

<!-- Generated from bun/commands.ts by bun run build:plugin. -->

## /help

```text
/help — List commands
/help goal — Show goal instructions
Use /help COMMAND to read instructions without invoking a model. Arguments to other commands keep their normal meaning: /goal help sets a goal whose objective is help.
```

## /status

```text
/status — Show the Telegram connection and bound Codex session
```

## /goal

```text
/goal — Show the current goal
/goal OBJECTIVE — Set a goal and start work
/goal edit OBJECTIVE — Change the objective
/goal pause — Pause automatic continuation
/goal resume — Resume the goal
/goal clear — Remove the goal

Example: /goal Fix the failing tests and verify the fixes
Objectives must contain 1–4,000 characters. Editing preserves paused status. Changing the objective resets its usage accounting. Pausing or clearing a goal does not interrupt the current turn; use /stop to interrupt it. Set and resume can start model work; viewing the goal and this help do not invoke a model.
```

## /compact

```text
/compact — Summarize conversation history to free context
Run after the current task finishes. Compaction can use the model.
```

## /rename

```text
/rename NAME — Rename this session
Example: /rename Release preparation
```

## /model

```text
/model — Show current and available models
/model MODEL [EFFORT] — Change model and optionally effort
Example: /model MODEL high
Use a model identifier shown by /model. Changes apply to subsequent turns.
```

## /effort

```text
/effort — Show current and available reasoning efforts
/effort LEVEL — Change effort for subsequent turns
Example: /effort high
```

## /fast

```text
/fast — Toggle Fast mode
/fast on or /fast off — Set Fast mode explicitly
/fast status — Show service tier
Availability depends on the current model. Fast mode can increase usage. Changes apply to subsequent turns.
```

## /plan

```text
/plan — Enable planning mode
/plan TASK — Enable planning mode and submit a planning request
/plan off — Return to default mode
/plan status — Show mode
Change modes after the current task finishes. /plan TASK starts model work; viewing or changing the mode alone does not.
```

## /permissions

```text
/permissions — Show current permissions and available profiles
/permissions PROFILE — Select an allowed profile
Use an exact profile identifier shown in the list. Profiles control file access and approval requirements. Changes apply to subsequent turns.
```

## /review

```text
/review — Review uncommitted changes
/review branch BRANCH — Review changes against a branch
/review commit SHA — Review a commit
/review INSTRUCTIONS — Run a custom review
Invoke this after the current task finishes. Reviews use the model; results appear in this chat.
```

## /mcp

```text
/mcp — List servers and tool counts
/mcp verbose — Also list tool names
This is a query; it does not invoke a model.
```

## /skills

```text
/skills — List enabled skills
/skills NAME TASK — Invoke a listed skill on a task
Invoking a skill starts model work. Listing skills does not.
```

## /plugins

```text
/plugins — List installed plugins and whether they are enabled
This command does not install, remove, or change plugins.
```

## /ps

```text
/ps — List background terminals belonging to this session
This command does not stop processes.
```

## /queue

```text
/queue — Count queued messages for this session
```

## /stop

```text
/stop — Interrupt the current turn
This does not pause an active goal. Use /goal pause to pause automatic continuation too.
```

## /approve

```text
/approve CODE — Approve a pending request using its code
```

## /deny

```text
/deny CODE — Deny a pending request using its code
```

## /answer

```text
/answer CODE QUESTION ANSWER — Answer a pending question
Use the request code and question identifier shown in the prompt.
```

## Other CLI commands

Only the commands above are implemented here. Terminal controls, account changes,
session switching, and other CLI commands are not forwarded as model prompts.
Use Codex CLI for these operations. An unknown command returns help and does not invoke a model.
