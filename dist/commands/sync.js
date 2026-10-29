// `teamsync sync` — fetch and update the current branch safely:
//  - default branch: fast-forward ONLY (merge commits/rebases forbidden);
//  - task branch: merge the updated default branch in (no history rewrite);
//  - dirty worktree: refuse; conflicts: abort the merge cleanly, list files,
//    print recovery steps. Never stashes, never force-pushes, never resets.
import { blockedError } from "../core/errors.js";
import { isTeamsyncBranch } from "../core/branch.js";
import { resolveEnrolledRepo } from "./shared.js";
export async function runSync(ctx, out) {
    const { git, config } = await resolveEnrolledRepo(ctx.cwd);
    const branch = await git.currentBranch();
    if (branch === null) {
        throw blockedError("Detached HEAD — sync needs a real branch.", [
            `Check out a branch first: \`git checkout ${config.defaultBranch}\`.`,
        ]);
    }
    // Refuse dirty worktrees BEFORE any mutation. User data outranks convenience.
    const entries = await git.statusEntries();
    if (entries.length > 0) {
        throw blockedError(`Worktree is dirty (${entries.length} change(s)) — sync refuses to run over uncommitted work.`, [
            "Commit your changes, or handle them yourself. TeamSync never stashes or discards changes.",
            `Changed files: ${entries.slice(0, 10).map((e) => e.path).join(", ")}${entries.length > 10 ? ", …" : ""}`,
        ]);
    }
    await git.fetch("origin");
    const baseRef = `refs/remotes/origin/${config.defaultBranch}`;
    if (!(await git.revExists(baseRef))) {
        throw blockedError(`origin/${config.defaultBranch} not found after fetch.`, [
            "The remote default branch may have been renamed; check `git remote show origin`.",
        ]);
    }
    if (branch === config.defaultBranch) {
        const ff = await git.mergeFastForwardOnly(baseRef);
        if (ff.updated) {
            out.success(`Fast-forwarded '${branch}' ${ff.from.slice(0, 7)} → ${ff.to.slice(0, 7)}.`);
        }
        else {
            out.say(`'${branch}' is already up to date with origin/${config.defaultBranch}.`);
        }
        return { branch, kind: ff.updated ? "fast-forward" : "up-to-date", updated: ff.updated };
    }
    if (!isTeamsyncBranch(branch)) {
        throw blockedError(`'${branch}' is neither the default branch nor a TeamSync task branch.`, [
            `Switch to the default branch or a task branch before syncing.`,
        ]);
    }
    const merge = await git.mergeNoRewrite(baseRef, `TeamSync: sync branch '${branch}' with ${config.defaultBranch}`);
    if (merge.kind === "conflict") {
        out.error(`Conflict merging ${config.defaultBranch} into '${branch}' — merge aborted, your files are untouched.`);
        const conflictFiles = merge.files ?? [];
        if (conflictFiles.length > 0) {
            out.say("Affected files:");
            out.list(conflictFiles);
        }
        out.say("How to resolve:");
        out.list(merge.guidance ?? []);
        ctx.events.emit({
            ts: new Date().toISOString(),
            type: "blocked",
            data: { op: "sync", branch, conflictFiles },
        });
        return { branch, kind: "conflict", updated: false, ...(conflictFiles.length > 0 ? { conflictFiles } : {}), ...(merge.guidance ? { guidance: merge.guidance } : {}) };
    }
    if (merge.kind === "up-to-date") {
        out.say(`'${branch}' already contains origin/${config.defaultBranch}.`);
        return { branch, kind: "up-to-date", updated: false };
    }
    out.success(`Merged origin/${config.defaultBranch} into '${branch}' (merge commit ${merge.sha?.slice(0, 7)}).`);
    out.detail("Publish the update with `teamsync submit` — fresh checks will run against the new base.");
    ctx.events.emit({ ts: new Date().toISOString(), type: "state.changed", data: { op: "sync", branch } });
    return { branch, kind: "merge", updated: true };
}
