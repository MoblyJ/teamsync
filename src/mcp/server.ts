// MCP server: `teamsync mcp` speaks the Model Context Protocol over stdio so
// AI coding tools can drive TeamSync — "vibe mode". One process per clone:
// launch it with cwd = your repository clone; repo tools act on that clone,
// team tools talk to the team server (TEAMSYNC_SERVER / last used).
//
// Protocol surface (JSON-RPC 2.0, newline-delimited, MCP 2024-11-05):
//   initialize / notifications/initialized / ping / tools/list / tools/call
import { makeContext, type GlobalOptions } from "../commands/context.js";
import { makeOutput, type Output } from "../ui/output.js";
import { isTeamsyncError } from "../core/errors.js";
import { runStart } from "../commands/start.js";
import { runSubmit } from "../commands/submit.js";
import { runStatus } from "../commands/status.js";
import { runSync } from "../commands/sync.js";
import { runStage, runCommit, runPush } from "../commands/simple.js";
import { runDoctor } from "../commands/doctor.js";
import { runTeamList } from "../commands/team.js";

/** Output that captures text instead of printing — stdio is the protocol. */
class CapturingOutput implements Output {
  lines: string[] = [];
  say(m: string): void { this.lines.push(m); }
  detail(m: string): void { this.lines.push(m); }
  success(m: string): void { this.lines.push(m); }
  warn(m: string): void { this.lines.push(`⚠ ${m}`); }
  error(m: string): void { this.lines.push(m); }
  list(items: readonly string[]): void { for (const i of items) this.lines.push(`- ${i}`); }
  json(value: unknown): void { this.lines.push(JSON.stringify(value, null, 2)); }
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, out: Output) => Promise<unknown>;
}

function s(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

const TOOLS: ToolDef[] = [
  {
    name: "teamsync_doctor",
    description: "Check prerequisites: runtime, git, gh auth, repo access, CI, auto-merge settings. Read-only; explains problems.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, out) => { const { runDoctor } = await import("../commands/doctor.js"); const ctx = makeContext({}, "doctor"); const r = await runDoctor(ctx, out, {}); return r.healthy; },
  },
  {
    name: "teamsync_start",
    description: "Create a unique task branch teamsync/<login>/<role>/<task>-<suffix> from the freshest default branch. Requires a clean worktree.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "short task name, e.g. 'homepage'" } }, required: ["task"], additionalProperties: false },
    handler: async (a, out) => runStart(makeContext({}, "start"), out, s(a, "task") ?? ""),
  },
  {
    name: "teamsync_stage",
    description: "Stage changes explicitly (all: true, or paths: [...]). Excludes likely secret files; warns on cross-role/shared paths.",
    inputSchema: { type: "object", properties: { all: { type: "boolean" }, paths: { type: "array", items: { type: "string" } } }, additionalProperties: false },
    handler: async (a, out) => runStage(makeContext({}, "stage"), out, { all: a.all === true, paths: strArray(a, "paths") }),
  },
  {
    name: "teamsync_commit",
    description: "Commit currently staged changes with a message.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    handler: async (a, out) => runCommit(makeContext({}, "commit"), out, s(a, "message")),
  },
  {
    name: "teamsync_push",
    description: "Push the current task branch to origin (never force, teamsync branches only). Does not create a PR.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, out) => { await runPush(makeContext({}, "push"), out); },
  },
  {
    name: "teamsync_submit",
    description: "All-in-one: stage (all or paths), commit, push, create/update the ONE PR for this branch, enroll auto-merge, report true integration state. Idempotent.",
    inputSchema: { type: "object", properties: { message: { type: "string" }, all: { type: "boolean" }, paths: { type: "array", items: { type: "string" } }, draft: { type: "boolean" } }, required: ["message"], additionalProperties: false },
    handler: async (a, out) => runSubmit(makeContext({}, "submit"), out, { message: s(a, "message"), all: a.all === true, paths: strArray(a, "paths"), draft: a.draft === true }),
  },
  {
    name: "teamsync_status",
    description: "Show open team PRs with roles, checks, conflicts, merge eligibility, and blockers. Read-only.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "include non-teamsync PRs" } }, additionalProperties: false },
    handler: async (a, out) => { await runStatus(makeContext({}, "status"), out, { all: a.all === true }); },
  },
  {
    name: "teamsync_sync",
    description: "Safely update: fast-forward the default branch, or merge the updated base into the current task branch. Refuses dirty worktrees; conflicts abort cleanly with file list.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, out) => runSync(makeContext({}, "sync"), out),
  },
  {
    name: "teamsync_team_list",
    description: "List teams on the TeamSync server (rosters, roles, admins). Server from TEAMSYNC_SERVER / last used.",
    inputSchema: { type: "object", properties: { server: { type: "string" } }, additionalProperties: false },
    handler: async (a, out) => runTeamList(makeContext({}, "team list"), out, { ...(s(a, "server") ? { server: s(a, "server") } : {}) }),
  },
];

export function listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Handle one JSON-RPC message. Returns the result object, or undefined for notifications. */
export async function handleMessage(msg: {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const { method, id, params } = msg;
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown): unknown =>
    isNotification ? undefined : { jsonrpc: "2.0", id, result };

  try {
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "teamsync", version: "0.1.0" },
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: listTools() });
      case "tools/call": {
        const name = String(params?.name ?? "");
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) {
          return isNotification
            ? undefined
            : { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
        const out = new CapturingOutput();
        try {
          await tool.handler(args, out);
          return reply({ content: [{ type: "text", text: out.lines.join("\n") || "done" }], isError: false });
        } catch (err) {
          const hints = isTeamsyncError(err) ? `\n\nHints:\n${err.hints.map((h) => `- ${h}`).join("\n")}` : "";
          return reply({
            content: [{ type: "text", text: `${(err as Error).message}${hints}` }],
            isError: true,
          });
        }
      }
      default:
        return isNotification
          ? undefined
          : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err) {
    return isNotification
      ? undefined
      : { jsonrpc: "2.0", id, error: { code: -32603, message: (err as Error).message } };
  }
}

/** The stdio loop behind `teamsync mcp`. */
export async function runMcpStdio(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === "") continue;
      let msg: Parameters<typeof handleMessage>[0];
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore malformed lines; protocol stays in sync per-line
      }
      void handleMessage(msg).then((res) => {
        if (res !== undefined) process.stdout.write(`${JSON.stringify(res)}\n`);
      });
    }
  });
  // Stay alive until stdin closes.
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
}

export { makeOutput };
