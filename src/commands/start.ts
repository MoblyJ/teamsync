// `teamsync start TASK` — clean worktree required; fetches the default branch
// and creates a unique task branch teamsync/<login>/<role>/<task>-<suffix>.
// Branch names carry login+role so teammates and `status` can attribute work.
import { usageError, blockedError } from "../core/errors.js";
import { makeTaskBranch, isTeamsyncBranch } from "../core/branch.js";
import { resolveEnrolledRepo } from "./shared.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface StartResult {
  branch: string;
  from: string;
}

export async function runStart(
  ctx: CommandContext,
  out: Output,
  task: string,
  _opts: Record<string, never> = {},
): Promise<StartResult> {
  if (!task.trim()) throw usageError("Task name is required.", ["Example: `teamsync start homepage`"]);

  const { git, config, role, root } = await resolveEnrolledRepo(ctx.cwd);
  const repository = config.repository;

  if (role === null) {
    throw usageError(
      `This clone has no local role recorded for ${repository}.`,
      ["Run `teamsync join " + repository + " --role <role>` inside this clone first."],
    );
  }

  // Detached HEAD is a distinct, actionable state — never guess.
  if (await git.isDetachedHead()) {
    throw blockedError("This clone is in detached-HEAD state.", [
      "Check out a branch first: `git checkout " + config.defaultBranch + "`.",
    ]);
  }

  // Clean worktree required — we are about to move the checkout pointer.
  if (!(await git.isClean())) {
    throw blockedError("Worktree is dirty — refusing to create a task branch on top of uncommitted changes.", [
      "Commit your changes to the current branch, or remove untracked files you do not need.",
      "TeamSync never stashes or discards your changes.",
    ]);
  }

  const me = await ctx.adapter.whoAmI();
  const defaultBranch = config.defaultBranch;

  // Fetch the freshest default branch, then verify it exists locally.
  await git.fetch("origin");
  const startPoint = `refs/remotes/origin/${defaultBranch}`;
  if (!(await git.revExists(startPoint))) {
    throw blockedError(`origin/${defaultBranch} not found after fetch.`, [
      `The remote's default branch may have changed. Run \`git remote show origin\` and check the config defaultBranch (${defaultBranch}).`,
    ]);
  }

  // Guarantee uniqueness against BOTH local and remote branches. Retry with a
  // fresh suffix on the (unlikely) collision; never reuse someone's branch.
  let branch: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = makeTaskBranch(me.login, role, task);
    if (!candidate) {
      throw usageError(`Could not build a valid branch name from task "${task}".`, [
        "Use letters, digits, dashes.",
      ]);
    }
    const localExists = await git.localBranchExists(candidate);
    if (localExists) continue;
    const heads = await git.lsRemoteHeads("origin");
    if (!heads.has(candidate)) {
      branch = candidate;
      break;
    }
  }
  if (!branch) {
    throw blockedError("Could not find a free branch name after several attempts.", [
      "Try a more distinctive task name.",
    ]);
  }

  await git.createAndCheckout(branch, startPoint);
  out.success(`Started task "${task}" on branch ${branch}`);
  out.detail(`Based on origin/${defaultBranch} (${await git.headSha(startPoint)}).`);
  out.detail(`Role ${role}: ${config.roles[role]?.paths.join(", ") ?? "(no paths)"}`);
  out.detail("Work in any editor, then `teamsync submit --all -m \"<message>\"`.");
  ctx.events.emit({
    ts: new Date().toISOString(),
    type: "command.end",
    data: { repository, branch, task, root },
  });
  void isTeamsyncBranch;
  return { branch, from: await git.headSha(startPoint) };
}
