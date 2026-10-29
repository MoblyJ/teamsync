// `teamsync serve` — run the local team coordination server (REST + SSE).
// Runs in ANY folder (project name is irrelevant); state lives in
// .teamsync-server.json in that folder by default. Never commit that file.
import path from "node:path";
import os from "node:os";
import { RegistryStore } from "../server/store.js";
import { createApp } from "../server/http.js";
import { startBeacon } from "../server/discovery.js";
export async function runServe(ctx, out, opts) {
    const port = opts.port ?? 4700;
    const host = opts.host ?? "0.0.0.0";
    // Folder-agnostic: the state file simply lives wherever the host starts it.
    const stateFile = path.resolve(process.cwd(), opts.state ?? ".teamsync-server.json");
    const store = new RegistryStore(stateFile);
    await store.load();
    const app = createApp(store, { port, host, ghPath: ctx.ghPath });
    const server = app.listen(port, host, async () => {
        const lan = lanAddresses()[0] ?? "127.0.0.1";
        out.success(`TeamSync team server running.`);
        out.detail(`Local:           http://localhost:${port}`);
        out.detail(`On your LAN:     http://${lan}:${port}`);
        out.detail(`State file:      ${stateFile}`);
        out.detail(`REST API + SSE events served from this one process.`);
        let beacon;
        if (opts.noDiscovery !== true) {
            // The beacon payload is built synchronously from a cached team count
            // (refreshed opportunistically); UDP payloads must never await.
            let teamCount = Object.keys((await store.load()).teams).length;
            const refreshCount = setInterval(() => {
                void store.load().then((r) => {
                    teamCount = Object.keys(r.teams).length;
                });
            }, 5000);
            refreshCount.unref?.();
            beacon = startBeacon(() => ({
                type: "teamsync-server",
                name: os.hostname(),
                port,
                teams: teamCount,
            }));
            out.detail(`Discovery:       broadcasting on UDP ${process.env.TEAMSYNC_DISCOVERY_PORT ?? 41733} (\`teamsync team discover\` finds me)`);
        }
        out.say("");
        out.say("Teammates join with:");
        out.list([
            `teamsync team join <team> --role <role> --server http://${lan}:${port}`,
            "or: teamsync team discover   (finds servers automatically on the LAN)",
        ]);
        out.say("");
        out.detail("Press Ctrl+C to stop. Teams/members persist in the state file.");
        const shutdown = async () => {
            await beacon?.stop();
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 1500).unref();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    });
    server.on("error", (err) => {
        const message = err.code === "EADDRINUSE"
            ? `Port ${port} is already in use.`
            : err.message;
        out.error(`Could not start server: ${message}`);
        if (err.code === "EADDRINUSE") {
            out.detail(`Stop the other instance, or pick another port: teamsync serve --port ${port + 1}`);
        }
        process.exit(1);
    });
}
function lanAddresses() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
        for (const iface of list ?? []) {
            if (iface.family === "IPv4" && !iface.internal)
                out.push(iface.address);
        }
    }
    return out;
}
