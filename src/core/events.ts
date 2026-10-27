// Structured events for a future dashboard. Today they can be written to a
// JSONL file with `--events <file>` or TEAMSYNC_EVENT_LOG; no server is built.
// The CLI presentation layer never depends on this — core emits, UI renders.
import { appendFileSync } from "node:fs";

export type TeamsyncEventType =
  | "command.start"
  | "command.end"
  | "git.op"
  | "gh.op"
  | "pr.created"
  | "pr.updated"
  | "pr.automerge.requested"
  | "pr.automerge.unavailable"
  | "state.changed"
  | "warning"
  | "blocked"
  | "error";

export interface TeamsyncEvent {
  ts: string; // ISO timestamp
  type: TeamsyncEventType;
  command?: string;
  /** Machine-readable payload; never contains credential material. */
  data?: Record<string, unknown>;
}

export interface EventSink {
  emit(event: TeamsyncEvent): void;
}

export class MemoryEventSink implements EventSink {
  readonly events: TeamsyncEvent[] = [];
  emit(event: TeamsyncEvent): void {
    this.events.push(event);
  }
}

export class JsonlFileEventSink implements EventSink {
  constructor(
    private readonly filePath: string,
    private readonly command?: string,
  ) {}
  emit(event: TeamsyncEvent): void {
    const full: TeamsyncEvent = { ...event };
    if (this.command) full.command = this.command;
    // Synchronous append; event volume is tiny (one line per meaningful step).
    appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, "utf8");
  }
}

export class NullEventSink implements EventSink {
  emit(): void {}
}

export function makeEventSink(filePath: string | undefined, command?: string): EventSink {
  return filePath ? new JsonlFileEventSink(filePath, command) : new NullEventSink();
}

export function nowIso(): string {
  return new Date().toISOString();
}
