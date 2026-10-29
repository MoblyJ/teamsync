// Shared auto-merge enrollment used by init and submit. Deliberately the ONLY
// place that talks to enablePullRequestAutoMerge. Never bypasses protections;
// on any obstacle it reports manual merge mode and leaves the PR intact.
import { GhCliAdapter as _gh } from "../core/github.js";
void _gh;
import { TeamsyncError } from "../core/errors.js";
import { withRetry } from "../core/retry.js";
function canWrite(info) {
    return info.viewerPermission === "admin" || info.viewerPermission === "maintain" || info.viewerPermission === "write";
}
function pickMethod(config, repo) {
    const wanted = config.mergePolicy.method;
    const allowed = [];
    if (repo.allowMergeCommit)
        allowed.push("merge");
    if (repo.allowSquashMerge)
        allowed.push("squash");
    if (repo.allowRebaseMerge)
        allowed.push("rebase");
    if (allowed.includes(wanted))
        return wanted;
    return allowed[0] ?? "merge";
}
export async function enrollAutoMerge(ctx, repository, pr, repo, config, out) {
    if (!config.mergePolicy.autoMerge)
        return "unavailable";
    if (pr.autoMerge)
        return "already";
    if (!repo.allowAutoMerge) {
        ctx.events.emit({
            ts: new Date().toISOString(),
            type: "pr.automerge.unavailable",
            data: { pr: pr.number, reason: "repository-setting-disabled" },
        });
        out?.detail("Auto-merge is disabled in repository settings — manual merge mode (PR left open and intact).");
        return "manual";
    }
    if (!canWrite(repo)) {
        ctx.events.emit({
            ts: new Date().toISOString(),
            type: "pr.automerge.unavailable",
            data: { pr: pr.number, reason: `permission-${repo.viewerPermission}` },
        });
        out?.detail(`Your permission (${repo.viewerPermission}) cannot enable auto-merge — manual merge mode.`);
        return "manual";
    }
    const [owner, repoName] = repository.split("/");
    const method = pickMethod(config, repo);
    try {
        // Bounded retries for transient failures; the mutation is idempotent
        // (enabling twice is a no-op) so a retry cannot corrupt state.
        await withRetry(() => ctx.adapter.enableAutoMerge(owner, repoName, pr.number, method), (err) => err instanceof TeamsyncError && err.exitCode === 5, { attempts: 3 });
        ctx.events.emit({
            ts: new Date().toISOString(),
            type: "pr.automerge.requested",
            data: { pr: pr.number, method },
        });
        return "requested";
    }
    catch (err) {
        const message = err instanceof TeamsyncError ? err.message : String(err);
        ctx.events.emit({
            ts: new Date().toISOString(),
            type: "pr.automerge.unavailable",
            data: { pr: pr.number, reason: message.slice(0, 200) },
        });
        out?.warn(`Could not enable auto-merge (${message.slice(0, 160)}) — manual merge mode; the PR stays open and intact.`);
        return "manual";
    }
}
