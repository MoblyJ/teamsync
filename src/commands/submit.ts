// `teamsync submit` — show changes, stage explicitly (--all or named paths,
// excluding likely secret files), commit, push, and create-or-update ONE PR.
// Then enroll GitHub-native auto-merge when possible and report the TRUE
// integration state. Idempotent: retried submits reuse the same PR and never
// duplicate commits.
import path from "node:path";
import { GitClient } from "../core/git.js";
import { resolveEnrolledRepo } from "./shared.js";
import { findLikelySecretFiles, splitExcluded } from "../core/secrets.js";
import { classifyPath } from "../core/config.js";
import { usageError, blockedError, TeamsyncError } from "../core/errors.js";
import { isTeamsyncBranch, parseTaskBranch } from "../core/branch.js";
import { assessIntegration } from "../core/policy.js";
import { withRetry } from "../core/retry.js";
import { enrollAutoMerge } from "./automerge.js";
import type { Output } from "../ui/output.js";
import type { CommandContext } from "./context.js";

export interface SubmitOptions {
  all?: boolean;
  paths?: string[];
  message?: string;
  draft?: boolean;
}

export interface SubmitResult {
  pushed: boolean;
  committed: boolean;
  pr: { number: number; url: string; state: string } | null;
  integration: ReturnType<typeof assessIntegration> | null;
  excluded: Array<{ path: string; reason: string }>;
}

export async function runSubmit(ctx: CommandContext, out: Output, opts: SubmitOptions): Promise<SubmitResult> {
  const { git, config, role } = await resolveEnrolledRepo(ctx.cwd);
  const repository = config.repository;

  // Branch contract: submit operates on a teamsync task branch only. The CLI
  // never pushes to the default branch.
  const branch = await git.currentBranch();
  if (branch === null) {
    throw blockedError("Detached HEAD — `teamsync submit` needs a task branch.", [
      "Check out your task branch, or start one with `teamsync start <task>`.",
    ]);
  }
  if (!isTeamsyncBranch(branch)) {
    throw usageError(`Current branch '${branch}' is not a TeamSync task branch.`, [
      "Use `teamsync start <task>` to create one.",
    ]);
  }
  const parts = parseTaskBranch(branch);
  const effectiveRole = parts?.role ?? role ?? "unknown";

  // ---- gather changes -------------------------------------------------------
  const entries = await git.statusEntries();
  const dirty = entries.length > 0;
  const localHead = await git.headSha();

  // Already-committed-but-unpushed work is submittable content too.
  await git.fetch("origin");
  const remoteSha = (await git.lsRemoteHeads("origin")).get(branch) ?? null;
  const hasUnpushedCommits = remoteSha === null || remoteSha !== localHead;

  if (!dirty && !hasUnpushedCommits) {
    throw usageError("Nothing to submit: no changes in the worktree and the branch is already up to date on the remote.", [
      "Edit files first, or use `teamsync status` to see your PR's integration state.",
    ]);
  }

  // ---- staging --------------------------------------------------------------
  let committed = false;
  let stagedCount = 0;
  const excluded: Array<{ path: string; reason: string }> = [];

  if (dirty) {
    if (opts.all !== true && (opts.paths === undefined || opts.paths.length === 0)) {
      throw usageError(
        "Specify what to stage: pass `--all` or explicit paths. TeamSync never stages implicitly.",
        [
          `Changed files:\n${entries.map((e) => `  ${e.code} ${e.path}`).join("\n")}`,
          "Review them, then `teamsync submit --all -m \"…\"` or name the paths to include.",
        ],
      );
    }

    let candidates: string[];
    if (opts.all === true) {
      candidates = entries.map((e) => e.path);
    } else {
      // Explicit paths: typo safety — must match actual changed entries.
      const wanted = new Set(opts.paths!.map((p) => git.validateInsideRepo(p)));
      candidates = entries.filter((e) => wanted.has(e.path)).map((e) => e.path);
      const missing = [...wanted].filter((w) => !entries.some((e) => e.path === w));
      if (missing.length > 0) {
        throw usageError(`These paths have no changes: ${missing.join(", ")}`, [
          "Only changed files can be staged. Run `git status` to see actual changes.",
        ]);
      }
    }

    // Secret exclusion: never stage likely credential files; explain why.
    const secretMatches = findLikelySecretFiles(candidates);
    const { kept, excludedFiles } = splitExcluded(
      candidates.map((p) => ({ path: p })),
      secretMatches,
    );
    for (const f of excludedFiles) {
      excluded.push({
        path: f.path,
        reason: secretMatches.find((s) => s.path === f.path)?.reason ?? "likely secret file",
      });
    }

    // An explicitly named secret file is a hard stop (the user insisted).
    if (opts.paths !== undefined) {
      const explicitlyNamed = new Set(opts.paths.map((p) => p.replace(/\\/g, "/")));
      const hit = excluded.filter((e) => explicitlyNamed.has(e.path));
      if (hit.length > 0) {
        throw blockedError(
          `Refusing to stage likely secret file(s): ${hit.map((h) => `${h.path} (${h.reason})`).join(", ")}.`,
          [
            "Rename the file, add it to .gitignore, or commit it deliberately with plain git if you are certain it is safe.",
          ],
        );
      }
    }

    if (kept.length > 0) {
      // Advisory ownership warnings — never blocking.
      for (const f of kept) {
        const rel = f.path;
        const ownership = classifyPath(config, effectiveRole, rel);
        if (ownership === "outside-role") {
          const w = `${rel} is outside your role's paths (${effectiveRole}) — confirm that's intended.`;
          out.warn(`⚠ ${w}`);
          ctx.events.emit({ ts: new Date().toISOString(), type: "warning", data: { message: w } });
        } else if (ownership === "shared") {
          const w = `${rel} is a SHARED path (contracts/lockfiles/workflows) — coordinate with the team.`;
          out.warn(`⚠ ${w}`);
          ctx.events.emit({ ts: new Date().toISOString(), type: "warning", data: { message: w } });
        }
      }

      await git.add(kept.map((f) => f.path));
      const staged = await git.stagedPaths();
      if (staged.length > 0) {
        if (!opts.message) {
          throw usageError("A commit message is required when there are changes to commit: -m \"<message>\".", []);
        }
        await git.commit(opts.message);
        committed = true;
        stagedCount = staged.length;
      }
    }
  }

  // ---- push -----------------------------------------------------------------
  const finalHead = await git.headSha();
  let pushed = false;
  if (remoteSha !== finalHead) {
    await withRetry(
      async () => {
        // Re-check remote state before every attempt so a retry can never
        // assume the previous push failed.
        const current = (await git.lsRemoteHeads("origin")).get(branch) ?? null;
        if (current === finalHead) return; // already landed — stop retrying
        await git.pushNewBranch(branch);
      },
      (err) => err instanceof TeamsyncError && err.exitCode === 5,
      { attempts: 3, onRetry: (n, e) => out.detail(`Retry ${n}: ${(e as Error).message.slice(0, 120)}`) },
    );
    pushed = true;
    ctx.events.emit({ ts: new Date().toISOString(), type: "git.op", data: { op: "push", branch } });
  }

  // ---- PR: find or create exactly one --------------------------------------
  const [owner, repoName] = repository.split("/");
  const body = prBody(config, parts?.task ?? branch, effectiveRole, opts.message);
  let pr = await ctx.adapter.findPRByHead(owner!, repoName!, branch);
  if (pr) {
    ctx.events.emit({ ts: new Date().toISOString(), type: "pr.updated", data: { pr: pr.number, branch } });
  } else {
    const title = opts.message?.split("\n")[0]?.trim() || `TeamSync: ${parts?.task ?? branch}`;
    pr = await withRetry(
      () =>
        ctx.adapter.createPull(owner!, repoName!, {
          head: branch,
          base: config.defaultBranch,
          title,
          body,
          ...(opts.draft ? { draft: true } : {}),
        }),
      (err) => err instanceof TeamsyncError && err.exitCode === 5,
      { attempts: 3 },
    );
    ctx.events.emit({ ts: new Date().toISOString(), type: "pr.created", data: { pr: pr.number, branch } });
  }

  // ---- auto-merge enrollment --------------------------------------------------
  const info = await ctx.adapter.getRepo(owner!, repoName!);
  const enrollResult = await enrollAutoMerge(ctx, repository, pr, info, config, out);

  // ---- true integration state -------------------------------------------------
  const fresh = await ctx.adapter.getPull(owner!, repoName!, pr.number);
  let reviewDecision = null;
  try {
    reviewDecision = await ctx.adapter.getReviewDecision(owner!, repoName!, fresh.number);
  } catch {
    reviewDecision = null;
  }
  let checks: Awaited<ReturnType<typeof ctx.adapter.getChecks>> = [];
  try {
    checks = await ctx.adapter.getChecks(owner!, repoName!, fresh.headRefOid);
  } catch {
    checks = [];
  }
  const assessment = assessIntegration({
    pr: { ...fresh, reviewDecision },
    checks,
    requiredChecks: config.checks.required,
    repo: info,
    autoMergeWanted: config.mergePolicy.autoMerge,
    autoMergeEnrollAttempted: true,
  });

  // ---- report -------------------------------------------------------------------
  out.say("");
  out.success(
    `Submitted: ${stagedCount > 0 ? `${stagedCount} file(s) committed` : "no new commit"}${pushed ? ", pushed" : ", branch already current on remote"}`,
  );
  out.say(`PR #${fresh.number}: ${fresh.url}`);
  out.say(`Integration state: ${assessment.summary}`);
  if (excluded.length > 0) {
    out.say("Excluded likely secret files (never staged):");
    out.list(excluded.map((e) => `${e.path} — ${e.reason}`));
    out.detail("Commit these deliberately with plain git only if you are certain they are safe.");
  }
  if (assessment.blockers.length > 0) {
    out.warn("Blockers:");
    out.list(assessment.blockers);
  }
  if (enrollResult === "requested") {
    out.detail("Auto-merge engaged — GitHub merges server-side when required checks pass. `teamsync watch` to follow along.");
  }

  const result: SubmitResult = {
    pushed,
    committed,
    pr: { number: fresh.number, url: fresh.url, state: assessment.state },
    integration: assessment,
    excluded,
  };
  if (ctx.json) out.json(result);
  return result;
}

function prBody(config: { repository: string }, task: string, role: string, message?: string): string {
  return [
    message ?? "",
    "",
    "---",
    `TeamSync task branch — task: \`${task}\`, role: \`${role}\`, repository: \`${config.repository}\`.`,
    "Merges automatically via GitHub auto-merge only after required checks (and any required reviews) pass.",
  ].join("\n");
}
