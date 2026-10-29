// Structured events for a future dashboard. Today they can be written to a
// JSONL file with `--events <file>` or TEAMSYNC_EVENT_LOG; no server is built.
// The CLI presentation layer never depends on this — core emits, UI renders.
import { appendFileSync } from "node:fs";
export class MemoryEventSink {
    events = [];
    emit(event) {
        this.events.push(event);
    }
}
export class JsonlFileEventSink {
    filePath;
    command;
    constructor(filePath, command) {
        this.filePath = filePath;
        this.command = command;
    }
    emit(event) {
        const full = { ...event };
        if (this.command)
            full.command = this.command;
        // Synchronous append; event volume is tiny (one line per meaningful step).
        appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, "utf8");
    }
}
export class NullEventSink {
    emit() { }
}
export function makeEventSink(filePath, command) {
    return filePath ? new JsonlFileEventSink(filePath, command) : new NullEventSink();
}
export function nowIso() {
    return new Date().toISOString();
}
