// Git operations via subprocess. All commands use argument arrays (proc.run);
// no shell interpolation ever. The client is injectable so tests can use real
// temporary repositories. Remote-affecting calls (fetch/push/ls-remote) fail
// loudly — a network error must never be mistaken for "branch doesn't exist".
import path from "node:path";
import { run, executableName } from "./proc.js";
import { blockedError, TeamsyncError, ExitCode } from "./errors.js";
import { redact } from "./redact.js";
const GIT = executableName("git");
export function gitError(message, hints, exitCode = ExitCode.GENERAL) {
    return new TeamsyncError({ message, code: "git", exitCode, hints });
}
/** Normalize git remote URLs (https/ssh forms) to "OWNER/REPO" when they point at github.com. */
export function remoteUrlToSlug(url) {
    const https = /^https?:\/\/(?:[^/@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
    if (https)
        return `${https[1]}/${https[2]}`;
    const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
    if (ssh)
        return `${ssh[1]}/${ssh[2]}`;
    const sshAlt = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
    if (sshAlt)
        return `${sshAlt[1]}/${sshAlt[2]}`;
    return null;
}
export class GitClient {
    cwd;
    runFn;
    constructor(
    /** Working tree root (or any dir inside it). */
    cwd, runFn = run) {
        this.cwd = cwd;
        this.runFn = runFn;
    }
    async raw(args) {
        return this.runFn(GIT, args, { cwd: this.cwd, timeoutMs: 120_000 });
    }
    /** Strict git call: throws on failure with a redacted message. */
    async git(args) {
        const res = await this.raw(args);
        if (!res.ok) {
            const detail = redact((res.stderr || res.stdout).trim());
            throw gitError(`git ${args[0]} failed: ${detail.slice(0, 500) || "(no output)"}`, [
                `Run \`git ${args.join(" ")}\` manually in this repository for more detail.`,
            ]);
        }
        return res.stdout;
    }
    /** Lenient git call: returns stdout (possibly empty) when git exits nonzero. */
    async gitSoft(args) {
        const res = await this.raw(args);
        return res.ok ? res.stdout : "";
    }
    async version() {
        return (await this.git(["--version"])).trim();
    }
    /** Null on detached HEAD — callers must treat that as a distinct state. */
    async currentBranch() {
        const name = (await this.gitSoft(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        return name === "HEAD" || name === "" ? null : name;
    }
    async isDetachedHead() {
        return (await this.currentBranch()) === null;
    }
    async headSha(rev = "HEAD") {
        return (await this.gitSoft(["rev-parse", rev])).trim();
    }
    async revExists(rev) {
        return (await this.gitSoft(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim().length === 40;
    }
    async isRepo() {
        return (await this.gitSoft(["rev-parse", "--is-inside-work-tree"])).trim() === "true";
    }
    async repoRoot() {
        return path.resolve((await this.git(["rev-parse", "--show-toplevel"])).trim());
    }
    async remoteUrl(remote = "origin") {
        // The CONFIGURED url — not `git remote get-url`, which resolves
        // insteadOf rewrites and would hide the github identity behind a mirror
        // or proxy URL. Transport keeps using git's rewritten URL regardless.
        const url = (await this.gitSoft(["config", "--get", `remote.${remote}.url`])).trim();
        return url || null;
    }
    async remoteSlug(remote = "origin") {
        const url = await this.remoteUrl(remote);
        return url ? remoteUrlToSlug(url) : null;
    }
    /** Porcelain v1 status entries for the whole worktree (includes untracked). */
    async statusEntries() {
        const out = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        const entries = [];
        // -z: NUL-separated; rename/copy entries carry two paths.
        const items = out.split("\0").filter((s) => s.length > 0);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const code = item.slice(0, 2);
            const orig = item.slice(3);
            if (code.includes("R") || code.includes("C")) {
                const next = items[++i];
                if (next === undefined)
                    break;
                entries.push({ code, path: next, origPath: orig });
            }
            else {
                entries.push({ code, path: orig });
            }
        }
        return entries;
    }
    async isClean() {
        return (await this.statusEntries()).length === 0;
    }
    /** Paths of currently staged (index vs HEAD) files. */
    async stagedPaths() {
        const out = await this.git(["diff", "--cached", "--name-only", "-z"]);
        return out.split("\0").filter(Boolean);
    }
    async add(paths) {
        if (paths.length === 0)
            return;
        await this.git(["add", "--", ...paths]);
    }
    async commit(message) {
        await this.git(["commit", "-m", message]);
        return this.headSha();
    }
    async fetch(remote = "origin", refspec) {
        const args = ["fetch", "--prune", "--no-tags", remote];
        if (refspec)
            args.push(refspec);
        const res = await this.raw(args);
        if (!res.ok) {
            const detail = redact((res.stderr || res.stdout).trim());
            if (/could not read Username|Authentication failed|403/i.test(detail)) {
                throw gitError(`git fetch failed: could not authenticate to '${remote}'.`, ["Run `gh auth login`, then `gh auth setup-git` so git uses your GitHub login."], ExitCode.AUTH);
            }
            throw gitError(`git fetch failed: ${detail.slice(0, 400)}`, [
                "Check your network connection, then retry.",
            ]);
        }
    }
    /**
     * Remote heads via ls-remote. STRICT: throws on failure. Callers use this
     * for branch-uniqueness checks, where a network error must NOT look like
     * "branch is free".
     */
    async lsRemoteHeads(remote = "origin") {
        const res = await this.raw(["ls-remote", "--heads", remote]);
        if (!res.ok) {
            const detail = redact((res.stderr || res.stdout).trim());
            throw gitError(`Could not list remote branches on '${remote}': ${detail.slice(0, 300)}`, ["Check your network connection and GitHub access, then retry."], ExitCode.NETWORK);
        }
        const map = new Map();
        for (const line of res.stdout.split("\n")) {
            const m = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(line.trim());
            if (m)
                map.set(m[2], m[1]);
        }
        return map;
    }
    async localBranchExists(name) {
        return (await this.git(["branch", "--list", "--format=%(refname:short)", name])).trim() === name;
    }
    async createAndCheckout(name, startPoint) {
        const args = ["checkout", "-b", name];
        if (startPoint)
            args.push(startPoint);
        await this.git(args);
    }
    async checkout(name) {
        await this.git(["checkout", name]);
    }
    async pushNewBranch(branch, remote = "origin") {
        const res = await this.raw(["push", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
        if (!res.ok) {
            const detail = redact((res.stderr || res.stdout).trim());
            if (/non-fast-forward|rejected|fetch first/i.test(detail)) {
                throw gitError(`Push rejected: remote branch '${branch}' already exists with different history.`, [
                    "Never force-push. Run `git fetch origin` and inspect `git log origin/" + branch + "`.",
                    "If the branch belongs to someone else, create your own with `teamsync start <task>`.",
                ], ExitCode.BLOCKED);
            }
            if (/could not read Username|Authentication failed|403/i.test(detail)) {
                throw gitError(`Push failed: git could not authenticate to '${remote}'.`, [
                    "Run `gh auth login` then `gh auth setup-git` so git pushes use your GitHub login.",
                    "Confirm you have write access to the repository.",
                ], ExitCode.AUTH);
            }
            throw gitError(`git push failed: ${detail.slice(0, 500)}`, [
                "Check your network connection, then retry `teamsync submit`.",
            ]);
        }
    }
    /**
     * Fast-forward the current branch to `ref`. Never creates a merge commit.
     * Returns updated=false when already up to date; throws when histories
     * diverged (caller decides policy — default branch sync requires ff).
     */
    async mergeFastForwardOnly(ref) {
        const from = await this.headSha();
        const res = await this.raw(["merge", "--ff-only", ref]);
        if (res.ok) {
            const to = await this.headSha();
            return { updated: to !== from, from, to };
        }
        const text = (res.stderr + res.stdout).trim();
        if (/\balready up to date\b/i.test(text)) {
            return { updated: false, from, to: from };
        }
        if (/[Nn]ot possible to fast-forward|diverged/i.test(text)) {
            throw blockedError(`Cannot fast-forward '${(await this.currentBranch()) ?? "detached HEAD"}' to ${ref}: histories diverged.`, [
                "Policy forbids merge commits or rewrites on this branch.",
                "On the default branch: compare `git log origin/<default>..HEAD` for local commits and move them to a task branch with `teamsync start`.",
            ]);
        }
        throw gitError(`git merge --ff-only ${ref} failed: ${redact(text).slice(0, 400)}`, [
            "Inspect `git status` — your files were left untouched.",
        ]);
    }
    /**
     * Merge `ref` into the current branch with a merge commit (no rebase, no
     * history rewrite). On conflict: aborts the merge immediately (restoring
     * the exact pre-merge state) and reports conflicted files + instructions.
     */
    async mergeNoRewrite(ref, message) {
        const args = ["merge", "--no-ff", "--no-edit"];
        if (message)
            args.push("-m", message);
        args.push(ref);
        const res = await this.raw(args);
        if (res.ok) {
            const text = (res.stderr + res.stdout).trim();
            if (/\balready up to date\b/i.test(text))
                return { kind: "up-to-date" };
            return { kind: "merged", sha: await this.headSha() };
        }
        const errText = (res.stderr + res.stdout).trim();
        if (/CONFLICT|Automatic merge failed/i.test(errText)) {
            // List conflicted paths from the index, then abort so the user's tree is
            // exactly as before. Resolution is deliberate, never silent.
            const out = await this.gitSoft(["diff", "--name-only", "--diff-filter=U", "-z"]);
            const files = out.split("\0").filter(Boolean);
            await this.gitSoft(["merge", "--abort"]);
            return {
                kind: "conflict",
                files,
                guidance: [
                    `Resolve deliberately: run \`git merge ${ref}\` in this clone.`,
                    "Edit the conflicted files, `git add` them, then `git commit` the merge.",
                    "Push when resolved, then run `teamsync submit` again to update the PR.",
                    "To abandon instead: `git merge --abort`.",
                ],
            };
        }
        throw gitError(`git merge ${ref} failed: ${redact(errText).slice(0, 400)}`, [
            "Inspect `git status` — your files were left untouched.",
        ]);
    }
    /** Read a file at a given rev (e.g. refs/remotes/origin/main:path). Raw mode. */
    async showFile(refAndPath) {
        const res = await this.raw(["show", refAndPath]);
        return res.ok ? res.stdout : null;
    }
    /** Repo-relative path validation: must resolve inside the worktree. */
    validateInsideRepo(relPath) {
        if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
            throw new TeamsyncError({
                message: `Refusing path outside the repository: ${relPath}`,
                code: "blocked",
                exitCode: ExitCode.USAGE,
                hints: ["Use repository-relative paths like apps/frontend/src/index.ts."],
            });
        }
        return relPath.split(path.sep).join("/");
    }
    async lastCommitSubject(ref = "HEAD") {
        return (await this.gitSoft(["log", "-1", "--format=%s", ref])).trim();
    }
    async isAncestor(ancestor, descendant) {
        return (await this.raw(["merge-base", "--is-ancestor", ancestor, descendant])).ok;
    }
    /** Clone into a destination that must not exist or must be empty. */
    static async clone(url, dest, runFn = run) {
        const res = await runFn(GIT, ["clone", url, dest], { timeoutMs: 300_000 });
        if (!res.ok) {
            const detail = redact((res.stderr || res.stdout).trim());
            throw gitError(`git clone failed: ${detail.slice(0, 400)}`, [
                "Check the repository URL and your access.",
                "Destination must not exist or must be empty.",
            ]);
        }
        return new GitClient(dest, runFn);
    }
}
