import { GhCliAdapter } from "../core/github.js";
import { makeEventSink } from "../core/events.js";
export function makeContext(opts, command) {
    const ctx = {
        adapter: new GhCliAdapter({ ghPath: opts.ghPath, cwd: process.cwd() }),
        events: makeEventSink(opts.events, command),
        json: opts.json === true,
        cwd: process.cwd(),
    };
    if (opts.ghPath)
        ctx.ghPath = opts.ghPath;
    return ctx;
}
