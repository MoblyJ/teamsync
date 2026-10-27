// Shared per-invocation context for command handlers. Adapters are injected
// here so every command is deterministic under test.
import type { GitHubAdapter } from "../core/github.js";
import { GhCliAdapter } from "../core/github.js";
import type { EventSink } from "../core/events.js";
import { makeEventSink } from "../core/events.js";

export interface CommandContext {
  adapter: GitHubAdapter;
  events: EventSink;
  json: boolean;
  ghPath?: string;
  cwd: string;
}

export interface GlobalOptions {
  json?: boolean;
  events?: string;
  ghPath?: string;
}

export function makeContext(opts: GlobalOptions, command: string): CommandContext {
  const ctx: CommandContext = {
    adapter: new GhCliAdapter({ ghPath: opts.ghPath, cwd: process.cwd() }),
    events: makeEventSink(opts.events, command),
    json: opts.json === true,
    cwd: process.cwd(),
  };
  if (opts.ghPath) ctx.ghPath = opts.ghPath;
  return ctx;
}
