// `teamsync status` — open team PRs, roles, checks, conflicts, merge
// eligibility, head/base revisions, refresh time, and actionable blockers.
// Read-only. Honest about visibility limits (no unpushed teammate edits).
import { buildTeamStatus } from "../core/status.js";
import { resolveEnrolledRepo } from "./shared.js";
import { style } from "../ui/output.js";
const STATE_MARKS = {
    conflict: { mark: "✗ CONFLICT", color: (s) => style.red(s) },
    "checks-failed": { mark: "✗ CHECKS FAILED", color: (s) => style.red(s) },
    "checks-blocked": { mark: "✗ CHECKS BLOCKED", color: (s) => style.yellow(s) },
    behind: { mark: "⟳ NEEDS SYNC", color: (s) => style.yellow(s) },
    "needs-review": { mark: "◈ REVIEW", color: (s) => style.yellow(s) },
    "checks-pending": { mark: "… CHECKS RUNNING", color: (s) => style.cyan(s) },
    blocked: { mark: "⛔ BLOCKED", color: (s) => style.yellow(s) },
    "manual-mode": { mark: "✋ MANUAL MERGE", color: (s) => style.yellow(s) },
    "auto-merge-requested": { mark: "⏩ AUTO-MERGE SET", color: (s) => style.green(s) },
    draft: { mark: "◦ DRAFT", color: (s) => style.dim(s) },
    merged: { mark: "✓ MERGED", color: (s) => style.green(s) },
    unknown: { mark: "? UNKNOWN", color: (s) => style.dim(s) },
};
export async function runStatus(ctx, out, opts = {}) {
    const { config, role } = await resolveEnrolledRepo(ctx.cwd);
    const me = await ctx.adapter.whoAmI();
    const status = await buildTeamStatus(ctx.adapter, config, me.login, {
        ...(opts.all ? { allPRs: true } : {}),
        ...(role ? { viewerRole: role } : {}),
    });
    if (!ctx.json)
        renderStatus(status, out);
    return { status };
}
export function renderStatus(status, out) {
    out.say(`${style.bold(status.repository)} — default branch: ${status.defaultBranch}`);
    out.say(`You: ${status.viewer.login}${status.viewer.role ? ` (${status.viewer.role})` : " (no local role)"} · refreshed ${status.generatedAt}`);
    out.say("");
    if (status.prs.length === 0) {
        out.say("No open team PRs.");
    }
    for (const pr of status.prs) {
        const mark = STATE_MARKS[pr.state] ?? STATE_MARKS.unknown;
        const who = `${pr.author}${pr.role ? `/${pr.role}` : ""}${pr.mine ? " (you)" : ""}`;
        out.say(style.bold(`#${pr.number}`) + ` ${mark.color(mark.mark)} — ${pr.title}`);
        out.detail(`${who} · ${pr.branch} → ${pr.baseBranch}`);
        out.detail(`head ${pr.headSha.slice(0, 7)} · base ${pr.baseSha.slice(0, 7)} · ${pr.url}`);
        const requiredChecks = pr.checks.filter((c) => c.required);
        if (requiredChecks.length > 0) {
            out.detail(requiredChecks
                .map((c) => `${checkGlyph(c.state)} ${c.name}${c.stale ? " (stale revision)" : ""}${c.required ? "" : " (optional)"}`)
                .join("  "));
        }
        else {
            out.detail("no required checks reported");
        }
        if (pr.blockers.length > 0) {
            for (const b of pr.blockers)
                out.detail(`→ ${b}`);
        }
        out.say("");
    }
    if (status.notes.length > 0) {
        for (const n of status.notes)
            out.detail(n);
    }
}
function checkGlyph(state) {
    switch (state) {
        case "success":
            return "✓";
        case "failure":
            return "✗";
        case "pending":
            return "…";
        case "skipped":
            return "⊘";
        case "cancelled":
            return "⨯";
        case "missing":
            return "?";
        default:
            return "·";
    }
}
