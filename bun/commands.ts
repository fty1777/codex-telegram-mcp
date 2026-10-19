import type { Client } from "./appserver";
import { sessionCommand, type CommandContext } from "./session-commands";

export const QUERY_METHODS = new Set([
  "thread/read",
  "thread/queue/list",
  "thread/goal/get",
  "model/list",
  "permissionProfile/list",
  "mcpServerStatus/list",
  "skills/list",
  "plugin/installed",
  "thread/backgroundTerminals/list",
]);

// Keep Telegram's command menu and /help in sync.
const descriptions = [
  ["help", "Commands"],
  ["status", "Session status"],
  ["activity", "Show or configure tool activity"],
  ["questions", "List questions waiting for your answer"],
  ["goal", "View or manage the session goal"],
  ["compact", "Compact conversation history"],
  ["rename", "Rename this session"],
  ["model", "View or change model and reasoning effort"],
  ["effort", "View or change reasoning effort"],
  ["fast", "Toggle Fast mode"],
  ["plan", "Manage planning mode"],
  ["permissions", "View or change permission profile"],
  ["review", "Start a code review"],
  ["mcp", "List MCP servers and tools"],
  ["skills", "List or invoke skills"],
  ["plugins", "List installed plugins"],
  ["ps", "List background terminals"],
  ["queue", "Pending messages"],
  ["stop", "Interrupt the active turn"],
  ["approve", "Approve a pending request"],
  ["deny", "Deny a pending request"],
  ["answer", "Answer a pending question"],
];
export const COMMANDS = descriptions.map(([command, description]) => ({
  command,
  description,
}));
export const HELP =
  descriptions
    .map(([command, description]) => `/${command} — ${description}`)
    .join("\n") +
  "\nUse /help COMMAND for usage and examples. Help does not use model tokens.";

const usage: Record<string, string> = {
  questions:
    "/questions — List unanswered questions and reply commands\nThis is a local query and does not use model tokens.",
  activity:
    "/activity — Show tool activity mode\n/activity transient — Show summaries and delete them when the task ends (default)\n/activity keep — Keep summaries after the task ends\n/activity off — Disable tool activity summaries\nSummaries show explored files, bounded search details, and safe command names; raw scripts and arbitrary outputs stay hidden. This setting does not change normal progress messages or final answers.",
  help: "/help — List commands\n/help goal — Show goal instructions\nUse /help COMMAND to read instructions without invoking a model. Arguments to other commands keep their normal meaning: /goal help sets a goal whose objective is help.",
  goal: "/goal — Show the current goal\n/goal OBJECTIVE — Set a goal and start work\n/goal edit OBJECTIVE — Change the objective\n/goal pause — Pause automatic continuation\n/goal resume — Resume the goal\n/goal clear — Remove the goal\n\nExample: /goal Fix the failing tests and verify the fixes\nObjectives must contain 1–4,000 characters. Editing preserves paused status. Changing the objective resets its usage accounting. Pausing or clearing a goal does not interrupt the current turn; use /stop to interrupt it. Set and resume can start model work; viewing the goal and this help do not invoke a model.",
  model:
    "/model — Show current and available models\n/model MODEL [EFFORT] — Change model and optionally effort\nExample: /model MODEL high\nUse a model identifier shown by /model. Changes apply to subsequent turns.",
  effort:
    "/effort — Show current and available reasoning efforts\n/effort LEVEL — Change effort for subsequent turns\nExample: /effort high",
  fast: "/fast — Toggle Fast mode\n/fast on or /fast off — Set Fast mode explicitly\n/fast status — Show service tier\nAvailability depends on the current model. Fast mode can increase usage. Changes apply to subsequent turns.",
  plan: "/plan — Enable planning mode\n/plan TASK — Enable planning mode and submit a planning request\n/plan off — Return to default mode\n/plan status — Show mode\nChange modes after the current task finishes. /plan TASK starts model work; viewing or changing the mode alone does not.",
  permissions:
    "/permissions — Show current permissions and available profiles\n/permissions PROFILE — Select an allowed profile\nUse an exact profile identifier shown in the list. Profiles control file access and approval requirements. Changes apply to subsequent turns.",
  review:
    "/review — Review uncommitted changes\n/review branch BRANCH — Review changes against a branch\n/review commit SHA — Review a commit\n/review INSTRUCTIONS — Run a custom review\nInvoke this after the current task finishes. Reviews use the model; results appear in this chat.",
  mcp: "/mcp — List servers and tool counts\n/mcp verbose — Also list tool names\nThis is a query; it does not invoke a model.",
  skills:
    "/skills — List enabled skills\n/skills NAME TASK — Invoke a listed skill on a task\nInvoking a skill starts model work. Listing skills does not.",
  plugins:
    "/plugins — List installed plugins and whether they are enabled\nThis command does not install, remove, or change plugins.",
  ps: "/ps — List background terminals belonging to this session\nThis command does not stop processes.",
  compact:
    "/compact — Summarize conversation history to free context\nRun after the current task finishes. Compaction can use the model. Start and completion notices appear here; completion includes elapsed time when available.",
  rename:
    "/rename NAME — Rename this session\nExample: /rename Release preparation",
  status: "/status — Show the Telegram connection and bound Codex session",
  queue: "/queue — Count queued messages for this session",
  stop: "/stop — Interrupt the current turn\nThis does not pause an active goal. Use /goal pause to pause automatic continuation too.",
  approve: "/approve CODE — Approve a pending request using its code",
  deny: "/deny CODE — Deny a pending request using its code",
  answer:
    "/answer CODE QUESTION ANSWER — Answer a pending question\nUse the request code and question identifier shown in the prompt.",
};

export function commandHelp(topic = "") {
  const name = topic.trim().replace(/^\//, "");
  return name
    ? (usage[name] ??
        `No help for /${name}. Use /help to see supported commands.`)
    : HELP;
}

export function parseCommand(text: string) {
  const match = /^(\/[^\s@]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return { command: match?.[1] ?? text, args: match?.[2]?.trim() ?? "" };
}

function goalSummary(goal: any): string {
  if (!goal)
    return "No goal set. Use /goal OBJECTIVE to set one.\nUse /help goal for instructions and examples.";
  const states: Record<string, string> = {
    active: "Active",
    paused: "Paused",
    blocked: "Blocked",
    usageLimited: "Usage limit reached",
    budgetLimited: "Token budget reached",
    complete: "Achieved",
  };
  return (
    `Goal: ${goal.objective}\nStatus: ${states[goal.status] ?? goal.status}` +
    `\nTokens used: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget}`}` +
    `\nTime used: ${Math.floor(goal.timeUsedSeconds)}s\nUse /help goal for instructions and examples.`
  );
}

// Operate on the bound thread rather than interpreting slash text as a model
// prompt. Codex itself may start work when a goal becomes active. Returning null
// leaves integration-specific commands to Engine.
export async function nativeCommand(
  client: Client,
  threadId: string,
  command: string,
  args: string,
  active: boolean,
  context: CommandContext = {},
): Promise<string | null> {
  if (command === "/goal") {
    if (!args || args === "edit") {
      const { goal } = await client.call("thread/goal/get", { threadId });
      return (
        goalSummary(goal) +
        (args === "edit"
          ? "\nUse /goal edit OBJECTIVE to replace the objective."
          : "")
      );
    }
    if (args === "clear") {
      const { cleared } = await client.call("thread/goal/clear", {
        threadId,
        origin: "user",
      });
      return cleared ? "Goal cleared." : "No goal set.";
    }
    if (args === "pause" || args === "resume") {
      const { goal } = await client.call("thread/goal/get", { threadId });
      if (!goal) return goalSummary(null);
      return goalSummary(
        (
          await client.call("thread/goal/set", {
            threadId,
            origin: "user",
            status: args === "pause" ? "paused" : "active",
          })
        ).goal,
      );
    }
    const editing = /^edit\s/.test(args);
    const objective = editing ? args.replace(/^edit\s+/, "").trim() : args;
    if (!objective || Array.from(objective).length > 4000)
      return "A goal must contain 1–4,000 characters.";
    if (editing) {
      const { goal } = await client.call("thread/goal/get", { threadId });
      if (!goal) return goalSummary(null);
    }
    return goalSummary(
      (
        await client.call("thread/goal/set", {
          threadId,
          origin: "user",
          objective,
          // Editing a paused goal must not implicitly authorize resuming it.
          ...(editing ? {} : { status: "active" }),
        })
      ).goal,
    );
  }
  if (command === "/compact") {
    if (args) return "Use /compact without arguments.";
    if (active)
      return "Codex is working. Use /compact after the current task finishes.";
    await client.call("thread/compact/start", { threadId });
    return "Conversation compaction started.";
  }
  if (command === "/rename") {
    if (!args) return "Use /rename NAME to rename this session.";
    await client.call("thread/name/set", { threadId, name: args });
    return `Session renamed: ${args}`;
  }
  return sessionCommand(client, threadId, command, args, active, context);
}
