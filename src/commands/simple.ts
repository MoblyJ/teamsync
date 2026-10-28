// `teamsync stage / commit / push` — thin, explicit git verbs for people who
// want manual control of each step (or AI tools driving them one at a time).
// Same safety rails as submit: no implicit staging, secret-file exclusion,
// advisory role/shared-path warnings, teamsync-branch-only pushes.
import { resolveEnrolledRepo } from "./shared.js";
import { findLikelySecretFiles, splitExcluded } from "../core/secrets.js";
import { classifyPath } from "../core/config.js";
import { usageError, blockedError } from "../core/errors.js";
import { isTeamsyncBranch } from "../core/branch.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface StageOptions {
  all?: boolean;
  paths?: string[];
}

export async function runStage(ctx: CommandContext, out: Output, opts: StageOptions): Promise<string[]> {
  const { git, config, role } = await resolveEnrolledRepo(ctx.cwd);
  const entries = await git.statusEntries();
  if (entries.length === 0) {
    out.say("Nothing to stage — the worktree is clean.");
    return [];
  }
  if (opts.all !== true && (opts.paths === undefined || opts.paths.length === 0)) {
    throw usageError(
      "Specify what to stage: `--all` or explicit paths. TeamSync never stages implicitly.",
      [`Changed files:\n${entries.map((e) => `  ${e.code} ${e.path}`).join("\n")}`],
    );
  }

  let candidates: string[];
  if (opts.all === true) {
    candidates = entries.map((e) => e.path);
  } else {
    const wanted = new Set(opts.paths!.map((p) => git.validateInsideRepo(p)));
    candidates = entries.filter((e) => wanted.has(e.path)).map((e) => e.path);
    const missing = [...wanted].filter((w) => !entries.some((e) => e.path === w));
    if (missing.length > 0) {
      throw usageError(`These paths have no changes: ${missing.join(", ")}`, [
        "Run `git status` to see actual changes.",
      ]);
    }
  }

  const secretMatches = findLikelySecretFiles(candidates);
  const { kept, excludedFiles } = splitExcluded(
    candidates.map((p) => ({ path: p })),
    secretMatches,
  );
  if (opts.paths !== undefined) {
    const explicitlyNamed = new Set(opts.paths.map((p) => p.replace(/\\/g, "/")));
    const hit = excludedFiles.filter((f) => explicitlyNamed.has(f.path));
    if (hit.length > 0) {
      throw blockedError(`Refusing to stage likely secret file(s): ${hit.map((h) => h.path).join(", ")}.`, [
        "Rename the file, gitignore it, or use plain git if you are certain it is safe.",
      ]);
    }
  }
  if (excludedFiles.length > 0) {
    out.warn("Excluded likely secret files:");
    out.list(excludedFiles.map((f) => `${f.path} — ${secretMatches.find((s) => s.path === f.path)?.reason ?? "secret"}`));
  }

  const effectiveRole = (await git.currentBranch())?.startsWith("teamsync/")
    ? ((await import("../core/branch.js")).parseTaskBranch((await git.currentBranch())!)?.role ?? role)
    : role;
  for (const f of kept) {
    if (!effectiveRole) break;
    const ownership = classifyPath(config, effectiveRole, f.path);
    if (ownership === "outside-role") out.warn(`⚠ ${f.path} is outside your role's paths (${effectiveRole}).`);
    else if (ownership === "shared") out.warn(`⚠ ${f.path} is a SHARED path — coordinate with the team.`);
  }

  await git.add(kept.map((f) => f.path));
  out.success(`Staged ${kept.length} file(s).`);
  return kept.map((f) => f.path);
}

export async function runCommit(ctx: CommandContext, out: Output, message: string | undefined): Promise<string> {
  const { git } = await resolveEnrolledRepo(ctx.cwd);
  if (!message || message.trim() === "") {
    throw usageError('A commit message is required: -m "<message>".', []);
  }
  const staged = await git.stagedPaths();
  if (staged.length === 0) {
    throw usageError("Nothing staged to commit.", ["Stage first: `teamsync stage --all` (or explicit paths)."]);
  }
  const sha = await git.commit(message);
  out.success(`Committed ${sha.slice(0, 7)} — "${message}"`);
  out.detail("Push with `teamsync push`, or create/update the PR in one step with `teamsync submit -m \"…\"`.");
  return sha;
}

export async function runPush(ctx: CommandContext, out: Output): Promise<void> {
  const { git } = await resolveEnrolledRepo(ctx.cwd);
  const branch = await git.currentBranch();
  if (branch === null) {
    throw blockedError("Detached HEAD — push needs a branch.", ["Check out a branch first."]);
  }
  if (!isTeamsyncBranch(branch)) {
    throw usageError(`'${branch}' is not a TeamSync task branch — push refuses to move shared branches implicitly.`, [
      "Use `teamsync start <task>` for team work, or plain `git push` if you really mean it.",
    ]);
  }
  const localHead = await git.headSha();
  await git.fetch("origin");
  const remote = (await git.lsRemoteHeads("origin")).get(branch) ?? null;
  if (remote === localHead) {
    out.say(`'${branch}' is already up to date on origin — nothing pushed.`);
    return;
  }
  if (remote !== null && !(await git.isAncestor(remote, localHead))) {
    throw blockedError(`Remote '${branch}' has commits you don't have — push would be rejected.`, [
      "Run `teamsync sync` to merge the remote state, or inspect `git log origin/" + branch + "`.",
      "TeamSync never force-pushes.",
    ]);
  }
  await git.pushNewBranch(branch);
  out.success(`Pushed '${branch}' (${localHead.slice(0, 7)}) to origin.`);
  const slug = await git.remoteSlug();
  if (slug) {
    const [owner, repoName] = slug.split("/") as [string, string];
    const pr = await ctx.adapter.findPRByHead(owner, repoName, branch);
    if (pr) out.detail(`PR #${pr.number}: ${pr.url}`);
    else out.detail('No PR yet — run `teamsync submit -m "…"` to open one.');
  }
}
