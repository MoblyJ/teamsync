// Integration-policy reporting: turn raw PR + checks + capabilities data into
// a truthful, actionable state. This module is pure — no I/O — so every rule
// (stale checks, skipped ≠ success, conflicts stay blocked, manual mode) is
// unit-testable.
//
// Invariants enforced here (mirroring the product requirements):
//  1. Success is never inherited: checks computed against a different head
//     SHA than the PR's current head are STALE and reported as pending.
//  2. Skipped/neutral required checks are NOT success.
//  3. Conflicts and BEHIND always block, with recovery guidance.
//  4. Reviews, when required, block regardless of check state.
//  5. Auto-merge enrollment vs. actual merge are distinct states.
//  6. When auto-merge is unavailable, the PR stays intact and the CLI says
//     "manual merge mode" — it never merges by itself.
import type { CheckRun, PullRequest, RepoInfo, CheckState } from "./github.js";

export type IntegrationState =
  | "merged"
  | "draft"
  | "conflict"
  | "behind"
  | "checks-pending"
  | "checks-failed"
  | "checks-blocked"
  | "needs-review"
  | "auto-merge-requested"
  | "manual-mode"
  | "blocked"
  | "unknown";

export interface CheckReport {
  name: string;
  required: boolean;
  state: CheckState;
  source: CheckRun["source"];
  /** True when this run belongs to an older head revision. */
  stale: boolean;
  detailsUrl?: string;
}

export interface IntegrationAssessment {
  state: IntegrationState;
  /** One-line human summary. */
  summary: string;
  /** Actionable blockers; empty only when merged or fully ready-for-GitHub. */
  blockers: string[];
  hints: string[];
  checks: CheckReport[];
  staleChecks: boolean;
  autoMergeRequested: boolean;
  /** Auto-merge could not be used → human must merge; PR stays intact. */
  manualMode: boolean;
  merged: boolean;
}

export interface AssessInput {
  pr: PullRequest;
  /** Check runs for the PR's head (adapter should fetch for pr.headRefOid). */
  checks: CheckRun[];
  /** Names of checks that must succeed (config + readable protection rules). */
  requiredChecks: readonly string[];
  repo: Pick<RepoInfo, "allowAutoMerge" | "viewerPermission" | "allowSquashMerge" | "allowMergeCommit" | "allowRebaseMerge">;
  /** Whether this CLI/deployment wants auto-merge (config mergePolicy). */
  autoMergeWanted: boolean;
  /** True when enrollment was attempted during this run (submit flow). */
  autoMergeEnrollAttempted?: boolean;
}

export function assessIntegration(input: AssessInput): IntegrationAssessment {
  const { pr, requiredChecks } = input;
  const blockers: string[] = [];
  const hints: string[] = [];

  // --- merged -------------------------------------------------------------
  // A closed PR we found in "open" lists can't happen; callers may still pass
  // a merged/closed PR (fetched by number). merged state wins immediately.
  if (pr.state === "closed") {
    // Without merge_commit info at this layer, closed-and-not-merged is
    // "rejected"; the adapter's getPull marks merged PRs via state. We keep
    // it simple: closed ≠ open; callers report URLs.
    return {
      state: "merged",
      summary: "PR is closed (merged or rejected — see URL).",
      blockers: [],
      hints: [`See ${pr.url} for the outcome.`],
      checks: [],
      staleChecks: false,
      autoMergeRequested: false,
      manualMode: false,
      merged: true,
    };
  }

  if (pr.draft) {
    return {
      state: "draft",
      summary: "PR is a draft.",
      blockers: ["Mark the PR ready for review when the task is complete."],
      hints: [],
      checks: buildReports(pr, input.checks, requiredChecks),
      staleChecks: hasStaleChecks(pr, input.checks, requiredChecks),
      autoMergeRequested: pr.autoMerge !== null,
      manualMode: false,
      merged: false,
    };
  }

  // --- conflicts -----------------------------------------------------------
  if (pr.mergeable === false || pr.mergeStateStatus === "DIRTY") {
    return {
      state: "conflict",
      summary: "Merge conflict with the base branch — auto-merge is blocked.",
      blockers: ["Resolve conflicts locally, then push to this PR branch."],
      hints: [
        "Run `teamsync sync` to merge the updated base into your task branch; conflicted files are listed there.",
        `Conflicted file list is also shown on the PR page: ${pr.url}`,
      ],
      checks: buildReports(pr, input.checks, requiredChecks),
      staleChecks: hasStaleChecks(pr, input.checks, requiredChecks),
      autoMergeRequested: pr.autoMerge !== null,
      manualMode: false,
      merged: false,
    };
  }

  // --- behind: base moved; branch must be synchronized + rechecked ----------
  if (pr.mergeStateStatus === "BEHIND") {
    return {
      state: "behind",
      summary: "Base branch moved after this PR's last update — synchronization and fresh checks are required.",
      blockers: [
        "Synchronize with the updated base branch; checks must run against the new integration.",
      ],
      hints: ["Run `teamsync sync` to merge the updated base into this task branch, then `teamsync submit` to push."],
      checks: buildReports(pr, input.checks, requiredChecks),
      staleChecks: hasStaleChecks(pr, input.checks, requiredChecks),
      autoMergeRequested: pr.autoMerge !== null,
      manualMode: false,
      merged: false,
    };
  }

  // --- required checks ------------------------------------------------------
  const reports = buildReports(pr, input.checks, requiredChecks);
  const stale = hasStaleChecks(pr, input.checks, requiredChecks);

  const missing = reports.filter((c) => c.required && c.state === "missing");
  const pending = reports.filter((c) => c.required && c.state === "pending");
  const failed = reports.filter((c) => c.required && (c.state === "failure" || c.state === "cancelled"));
  const skipped = reports.filter((c) => c.required && (c.state === "skipped" || c.state === "neutral"));

  if (failed.length > 0) {
    for (const c of failed) {
      blockers.push(`Required check "${c.name}" ${c.state === "cancelled" ? "was cancelled" : "failed"}.${c.detailsUrl ? ` Details: ${c.detailsUrl}` : ""}`);
    }
    hints.push("Fix the issue and push again; a new push reruns checks. Do not re-run failed checks without a fix.");
    return done(pr, "checks-failed", `${failed.length} required check(s) failing.`, blockers, hints, reports, stale);
  }

  if (missing.length > 0) {
    for (const c of missing) blockers.push(`Required check "${c.name}" has not reported any run for this revision.`);
    hints.push(
      "If the check is path-filtered it may never run: prefer an aggregate gate job that always runs (see the TeamSync CI template), or fix the required-check name in branch settings.",
    );
    return done(pr, "checks-blocked", "A required check never ran for this revision.", blockers, hints, reports, stale);
  }

  if (skipped.length > 0) {
    for (const c of skipped) blockers.push(`Required check "${c.name}" is ${c.state} for this revision — not treated as success.`);
    hints.push(
      "GitHub counts skipped required checks as satisfied, but TeamSync refuses to call that success. Use an aggregate integration job that always executes.",
    );
    return done(pr, "checks-blocked", "A required check was skipped (ineligible) — not success.", blockers, hints, reports, stale);
  }

  if (stale || pending.length > 0) {
    if (stale) blockers.push("Checks on record ran against an older revision — a new push requires fresh results.");
    for (const c of pending) blockers.push(`Required check "${c.name}" is still running.`);
    return done(pr, "checks-pending", "Waiting for required checks on the current revision.", blockers, hints, reports, stale);
  }

  // --- reviews ---------------------------------------------------------------
  if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED") {
    blockers.push(
      pr.reviewDecision === "REVIEW_REQUIRED"
        ? "Repository requires review approval before merge."
        : "A reviewer requested changes — address them and re-request review.",
    );
    return done(pr, "needs-review", "Required reviews are not satisfied.", blockers, hints, reports, stale);
  }

  // --- auto-merge ------------------------------------------------------------
  const canAutoMerge =
    input.autoMergeWanted &&
    input.repo.allowAutoMerge &&
    (input.repo.viewerPermission === "admin" ||
      input.repo.viewerPermission === "maintain" ||
      input.repo.viewerPermission === "write");

  if (pr.autoMerge) {
    return {
      state: "auto-merge-requested",
      summary: `Auto-merge requested (${pr.autoMerge.mergeMethod}); GitHub will merge when all requirements pass.`,
      blockers: [],
      hints: ["GitHub merges server-side; this CLI does not need to keep running."],
      checks: reports,
      staleChecks: stale,
      autoMergeRequested: true,
      manualMode: false,
      merged: false,
    };
  }

  if (!input.autoMergeWanted) {
    return manualMode(
      pr,
      input,
      reports,
      stale,
      "Merge policy in .teamsync/config.json disables auto-merge.",
      ["Merge manually after checks pass, or set mergePolicy.autoMerge=true in the shared config."],
    );
  }

  if (!input.repo.allowAutoMerge) {
    return manualMode(
      pr,
      input,
      reports,
      stale,
      "Repository does not allow auto-merge (Settings → General → Pull Requests → Allow auto-merge).",
      [
        "A repository admin must enable it once; TeamSync never changes repository settings silently.",
        "Until then each PR must be merged by a human after checks pass (manual merge mode).",
      ],
    );
  }

  if (!canAutoMerge && input.autoMergeWanted) {
    return manualMode(
      pr,
      input,
      reports,
      stale,
      `Your permission level (${input.repo.viewerPermission}) cannot enable auto-merge.`,
      ["Ask a member with write access or above to enroll the PR, or merge it manually after checks pass."],
    );
  }

  if (pr.mergeStateStatus === "BLOCKED") {
    blockers.push("GitHub reports the PR as blocked; protection requirements are not fully satisfied.");
    hints.push(
      "Compare required checks/reviews in the branch protection settings with what actually ran on this PR.",
    );
    return done(pr, "blocked", "PR blocked by branch protection.", blockers, hints, reports, stale);
  }

  if (input.autoMergeWanted && input.autoMergeEnrollAttempted !== true) {
    // All known requirements pass but auto-merge is not enabled and we didn't
    // try yet in this run — this is the manual-mode fallback for status runs.
    return manualMode(
      pr,
      input,
      reports,
      stale,
      "Auto-merge is not enabled on this PR.",
      ["Run `teamsync submit` again to enroll it, or merge manually after checks pass."],
    );
  }

  // Everything we know about is satisfied and enrollment happened: GitHub is
  // about to merge (CLEAN) or will do so once its async checks settle.
  return {
    state: "auto-merge-requested",
    summary: "All known requirements pass; auto-merge is engaged.",
    blockers: [],
    hints: [],
    checks: reports,
    staleChecks: stale,
    autoMergeRequested: true,
    manualMode: false,
    merged: false,
  };
}

function done(
  pr: PullRequest,
  state: IntegrationState,
  summary: string,
  blockers: string[],
  hints: string[],
  checks: CheckReport[],
  staleChecks: boolean,
): IntegrationAssessment {
  return {
    state,
    summary,
    blockers,
    hints,
    checks,
    staleChecks,
    autoMergeRequested: pr.autoMerge !== null,
    manualMode: false,
    merged: false,
  };
}

function manualMode(
  pr: PullRequest,
  input: AssessInput,
  checks: CheckReport[],
  staleChecks: boolean,
  reason: string,
  extraHints: string[],
): IntegrationAssessment {
  return {
    state: "manual-mode",
    summary: `Manual merge mode — auto-merge unavailable. ${reason}`,
    blockers: [reason, "Merge the PR manually once checks and reviews pass."],
    hints: [...extraHints, `PR stays open and intact: ${pr.url}`],
    checks,
    staleChecks,
    autoMergeRequested: false,
    manualMode: true,
    merged: false,
  };
}

function buildReports(
  pr: PullRequest,
  checks: readonly CheckRun[],
  required: readonly string[],
): CheckReport[] {
  const reports: CheckReport[] = [];
  const seen = new Set<string>();
  for (const c of checks) {
    seen.add(c.name);
    reports.push({
      name: c.name,
      required: required.includes(c.name),
      state: c.state,
      source: c.source,
      stale: required.includes(c.name) && c.headSha !== pr.headRefOid,
      ...(c.detailsUrl ? { detailsUrl: c.detailsUrl } : {}),
    });
  }
  // Required checks with no run at all → explicit "missing", never silent.
  for (const name of required) {
    if (!seen.has(name)) {
      reports.push({ name, required: true, state: "missing", source: "actions", stale: false });
    }
  }
  return reports;
}

function hasStaleChecks(pr: PullRequest, checks: readonly CheckRun[], required: readonly string[]): boolean {
  return checks.some((c) => required.includes(c.name) && c.headSha !== pr.headRefOid);
}
