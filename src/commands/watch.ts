// `teamsync watch` — poll status until the team's PRs settle or Ctrl+C.
// Strictly read-only: never writes files, never merges. Server-side
// auto-merge does not depend on this process. Backs off on rate limits and
// renders an honest "offline/stale" state on network failures.
import { buildTeamStatus } from "../core/status.js";
import type { TeamStatus } from "../core/status.js";
import { resolveEnrolledRepo } from "./shared.js";
import { renderStatus } from "./status.js";
import { TeamsyncError } from "../core/errors.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface WatchOptions {
  intervalSeconds?: number;
  once?: boolean;
}

const CLEAR = "\u001b[2J\u001b[H";

export async function runWatch(ctx: CommandContext, out: Output, opts: WatchOptions = {}): Promise<void> {
  const intervalMs = Math.max(5, Math.round((opts.intervalSeconds ?? 30) * 1000)) ;
  const { config, role } = await resolveEnrolledRepo(ctx.cwd);
  const me = await ctx.adapter.whoAmI();

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);

  try {
    let delayMs = intervalMs;
    let lastStatus: TeamStatus | null = null;
    let consecutiveFailures = 0;

    while (!controller.signal.aborted) {
      const tickStart = Date.now();
      try {
        const status = await buildTeamStatus(ctx.adapter, config, me.login, {
          ...(role ? { viewerRole: role } : {}),
        });
        consecutiveFailures = 0;
        delayMs = intervalMs; // success resets backoff
        lastStatus = status;
        if (process.stdout.isTTY && !ctx.json) process.stdout.write(CLEAR);
        if (ctx.json) {
          out.json({ ...status, watching: { intervalMs, stale: false } });
        } else {
          renderStatus(status, out);
        }
        const active = status.prs.filter((p) => !p.merged && p.state !== "manual-mode");
        if (active.length === 0 && status.prs.length > 0) {
          out.success("No PRs waiting on anything — nothing left to watch.");
          return;
        }
      } catch (err) {
        consecutiveFailures += 1;
        // Exponential backoff capped at 5× interval; honest stale banner.
        delayMs = Math.min(intervalMs * 5, intervalMs * 2 ** consecutiveFailures);
        const isRate = err instanceof TeamsyncError && err.code === "network";
        if (!ctx.json) {
          out.warn(
            `Refresh failed (${(err as Error).message.slice(0, 120)}). Showing last known state from ${
              lastStatus?.generatedAt ?? "(never)"
            }.${isRate ? " Backing off due to rate limiting." : ""}`,
          );
        }
        if (lastStatus && !ctx.json && process.stdout.isTTY) {
          renderStatus({ ...lastStatus, generatedAt: lastStatus.generatedAt, notes: [`STALE: last refresh ${lastStatus.generatedAt}`] }, out);
        }
      }

      if (opts.once === true) return;

      // Sleep in short slices so Ctrl+C is responsive.
      const deadline = tickStart + delayMs;
      while (Date.now() < deadline && !controller.signal.aborted) {
        await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
      }
    }
    if (!ctx.json) out.say(`Watch stopped. (Interval was ${intervalMs / 1000}s.)`);
  } finally {
    process.off("SIGINT", onSignal);
  }
}
