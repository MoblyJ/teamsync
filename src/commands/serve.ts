// `teamsync serve` — run the local team coordination server + dashboard.
// Runs in ANY folder (project name is irrelevant); state lives in
// .teamsync-server.json in that folder by default. Never commit that file.
// `--tunnel` starts cloudflared (quick tunnel — free, no account) and prints
// a public URL + a ready-made join command, for teammates on other networks.
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RegistryStore } from "../server/store.js";
import { createApp } from "../server/http.js";
import { startBeacon } from "../server/discovery.js";
import { usageError } from "../core/errors.js";
import { redact } from "../core/redact.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface ServeOptions {
  port?: number;
  host?: string;
  state?: string;
  noDiscovery?: boolean;
  tunnel?: boolean;
  tunnelTimeoutMs?: number;
}

/** Extract the trycloudflare URL cloudflared prints once registered. */
export function parseTunnelUrl(logText: string): string | null {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(logText);
  return m ? m[0] : null;
}

/** Where we look for cloudflared, in order. First existing path wins. */
export function cloudflaredCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  const exe = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const list = [
    path.join(home, ".local", "bin", exe),
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    "/opt/homebrew/bin/cloudflared",
    "/snap/bin/cloudflared",
  ];
  if (platform === "win32") {
    list.unshift(path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "cloudflared", exe));
  }
  return list;
}

/** Find cloudflared: $TEAMSYNC_CLOUDFLARED, known paths, else bare name (PATH). */
export async function resolveCloudflaredPath(
  existsFn: (p: string) => Promise<boolean> = async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
): Promise<string> {
  if (process.env.TEAMSYNC_CLOUDFLARED) return process.env.TEAMSYNC_CLOUDFLARED;
  for (const c of cloudflaredCandidates()) {
    if (await existsFn(c)) return c;
  }
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

async function binaryWorks(bin: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const c = spawn(bin, ["--version"], { windowsHide: true, stdio: "ignore" });
      c.on("error", () => resolve(false));
      c.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

interface TunnelHandle {
  url: string | null;
  stop(): void;
}

async function startTunnel(port: number, out: Output, timeoutMs: number): Promise<TunnelHandle> {
  const bin = await resolveCloudflaredPath();
  const child = spawn(bin, ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let logText = "";
  let stopped = false;
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    logText += d;
  });
  child.stderr!.on("data", (d: string) => {
    logText += d;
  });
  child.on("error", (err) => {
    if (!stopped) out.warn(`cloudflared could not start: ${redact(err.message)}`);
  });
  child.on("close", () => {
    if (!stopped) out.warn("cloudflared exited — the public URL is no longer reachable (local server keeps running).");
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = parseTunnelUrl(logText);
    if (url) {
      return {
        url,
        stop: () => {
          stopped = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        },
      };
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const tail = logText.trim().split("\n").slice(-3).join(" ").slice(0, 200);
  throw usageError(
    `Tunnel did not come up within ${Math.round(timeoutMs / 1000)}s.${tail ? ` cloudflared said: ${redact(tail)}` : ""}`,
    [
      "Check your internet connection (the tunnel needs outbound access to Cloudflare).",
      `Try it manually first: ${bin} tunnel --url http://localhost:${port}`,
      "Or serve without --tunnel and share the LAN address instead.",
    ],
  );
}

export async function runServe(ctx: CommandContext, out: Output, opts: ServeOptions): Promise<void> {
  const port = opts.port ?? 4700;
  const host = opts.host ?? "0.0.0.0";
  // Folder-agnostic: the state file simply lives wherever the host starts it.
  const stateFile = path.resolve(process.cwd(), opts.state ?? ".teamsync-server.json");

  // Fail fast with install hints when --tunnel was asked for but cloudflared
  // is missing entirely — before anything binds.
  if (opts.tunnel === true) {
    const bin = await resolveCloudflaredPath();
    if (!(await binaryWorks(bin))) {
      throw usageError("`--tunnel` needs cloudflared, which is not installed.", [
        "Install it (free, no account needed):",
        "  Linux/WSL:  download cloudflared-linux-amd64 from https://github.com/cloudflare/cloudflared/releases/latest → save as ~/.local/bin/cloudflared, then: chmod +x ~/.local/bin/cloudflared",
        "  macOS:  brew install cloudflared",
        "  Windows:  winget install Cloudflare.cloudflared",
        "If it lives elsewhere: export TEAMSYNC_CLOUDFLARED=/path/to/cloudflared",
      ]);
    }
  }

  const store = new RegistryStore(stateFile);
  await store.load();

  const app = createApp(store, { port, host, ghPath: ctx.ghPath });

  const server = app.listen(port, host, async () => {
    const lan = lanAddresses()[0] ?? "127.0.0.1";
    out.success(`TeamSync team server running.`);
    out.detail(`Dashboard:      http://localhost:${port}`);
    out.detail(`On your LAN:    http://${lan}:${port}`);
    out.detail(`State file:     ${stateFile}`);

    let tunnel: TunnelHandle | null = null;
    if (opts.tunnel === true) {
      out.detail("Starting public tunnel (cloudflared quick tunnel — free, no account)…");
      try {
        tunnel = await startTunnel(port, out, opts.tunnelTimeoutMs ?? 45_000);
      } catch (err) {
        out.warn((err as Error).message);
        for (const h of (err as { hints?: string[] }).hints ?? []) out.detail(`→ ${h}`);
        out.warn("Continuing without a tunnel (local + LAN still work).");
      }
      if (tunnel?.url) {
        out.say("");
        out.success("Public dashboard (works from any network, mobile data included):");
        out.say(`  ${tunnel.url}`);
        out.say("");
        out.say("Teammates on other networks join with:");
        out.list([`teamsync team join <team> --role <role> --code <CODE> --server ${tunnel.url}`]);
        out.warn("Anyone with the URL can READ team rosters (join codes gate joining, not reading).");
        out.warn("The URL changes on each restart — share the new one after restarting.");
      }
    }

    let beacon: Awaited<ReturnType<typeof startBeacon>> | undefined;
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
        type: "teamsync-server" as const,
        name: os.hostname(),
        port,
        teams: teamCount,
      }));
      out.detail(`Discovery:      broadcasting on UDP ${process.env.TEAMSYNC_DISCOVERY_PORT ?? 41733} (\`teamsync team discover\` finds me)`);
    }

    out.say("");
    out.say("Teammates on the same Wi-Fi/LAN join with:");
    out.list([
      `teamsync team join <team> --role <role> --server http://${lan}:${port}`,
      "or: teamsync team discover   (finds servers automatically on the LAN)",
    ]);
    out.say("");
    out.detail("Press Ctrl+C to stop. Teams/members persist in the state file.");

    const shutdown = async () => {
      tunnel?.stop();
      await beacon?.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  server.on("error", (err) => {
    const message = (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `Port ${port} is already in use.`
      : (err as Error).message;
    out.error(`Could not start server: ${message}`);
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      out.detail(`Stop the other instance, or pick another port: teamsync serve --port ${port + 1}`);
    }
    process.exit(1);
  });
}

function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}
