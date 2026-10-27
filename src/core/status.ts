// Team status model: assembles PRs, roles, checks, and policy assessments
// into one structure consumed by both the human UI and `--json`. Deliberately
// dashboard-shaped: a future dashboard reuses this module directly.
import type { GitHubAdapter, PullRequest, RepoInfo } from "./github.js";
import type { IntegrationAssessment, IntegrationState } from "./policy.js";
import { assessIntegration } from "./policy.js";
import type { TeamsyncConfig } from "./config.js";
import { parseTaskBranch } from "./branch.js";

export interface TeamPRStatus {
  number: number;
  url: string;
  title: string;
  author: string;
  role: string | null;
  task: string | null;
  branch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  state: IntegrationState;
  summary: string;
  blockers: string[];
  hints: string[];
  checks: IntegrationAssessment["checks"];
  autoMergeRequested: boolean;
  manualMode: boolean;
  merged: boolean;
  mine: boolean;
}

export interface TeamStatus {
  repository: string;
  defaultBranch: string;
  generatedAt: string;
  viewer: { login: string; role: string | null };
  prs: TeamPRStatus[];
  /** Contextual notes, e.g. visibility limits of this data. */
  notes: string[];
}

export interface StatusOptions {
  /** Include non-teamsync PRs too (default: only teamsync/* task branches). */
  allPRs?: boolean;
  /** Membership role of the current user, if known locally. */
  viewerRole?: string | null;
}

export async function buildTeamStatus(
  adapter: GitHubAdapter,
  config: TeamsyncConfig,
  viewerLogin: string,
  options: StatusOptions = {},
): Promise<TeamStatus> {
  const [owner, repo] = config.repository.split("/");
  const repoInfo: RepoInfo = await adapter.getRepo(owner!, repo!);

  const required = new Set(config.checks.required);
  const protection = await adapter.getBranchProtection(owner!, repo!, repoInfo.defaultBranch);
  if (protection) for (const c of protection.requiredChecks) required.add(c);
  const requiredList = [...required];

  const openPRs: PullRequest[] = await adapter.listOpenPRs(owner!, repo!);
  const relevant = openPRs.filter((p) =>
    options.allPRs ? true : p.headRefName.startsWith("teamsync/"),
  );

  const prs: TeamPRStatus[] = [];
  for (const pr of relevant) {
    let reviewDecision: PullRequest["reviewDecision"] = null;
    try {
      reviewDecision = await adapter.getReviewDecision(owner!, repo!, pr.number);
    } catch {
      // Status views degrade rather than fail on a single PR lookup.
    }
    let checks: Awaited<ReturnType<typeof adapter.getChecks>> = [];
    try {
      checks = await adapter.getChecks(owner!, repo!, pr.headRefOid);
    } catch {
      checks = [];
    }
    const assessment = assessIntegration({
      pr: { ...pr, reviewDecision },
      checks,
      requiredChecks: requiredList,
      repo: repoInfo,
      autoMergeWanted: config.mergePolicy.autoMerge,
    });
    const parts = parseTaskBranch(pr.headRefName);
    prs.push({
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.authorLogin,
      role: parts?.role ?? null,
      task: parts?.task ?? null,
      branch: pr.headRefName,
      headSha: pr.headRefOid,
      baseBranch: pr.baseRefName,
      baseSha: pr.baseRefOid,
      state: assessment.state,
      summary: assessment.summary,
      blockers: assessment.blockers,
      hints: assessment.hints,
      checks: assessment.checks,
      autoMergeRequested: assessment.autoMergeRequested,
      manualMode: assessment.manualMode,
      merged: assessment.merged,
      mine: pr.authorLogin === viewerLogin,
    });
  }

  // Sort: mine first, then by state severity, then number.
  const severity: Record<string, number> = {
    conflict: 0,
    "checks-failed": 1,
    "checks-blocked": 2,
    behind: 3,
    "needs-review": 4,
    "checks-pending": 5,
    blocked: 6,
    "manual-mode": 7,
    "auto-merge-requested": 8,
    draft: 9,
    merged: 10,
    unknown: 11,
  };
  prs.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    const sa = severity[a.state] ?? 12;
    const sb = severity[b.state] ?? 12;
    if (sa !== sb) return sa - sb;
    return a.number - b.number;
  });

  return {
    repository: config.repository,
    defaultBranch: repoInfo.defaultBranch,
    generatedAt: new Date().toISOString(),
    viewer: { login: viewerLogin, role: options.viewerRole ?? null },
    prs,
    notes: [
      "Status covers pushed work only — teammates' unpushed local edits are never visible to anyone.",
      ...(protection ? [] : ["Branch protection details are not readable without admin rights; required checks come from .teamsync/config.json where unreadable."]),
    ],
  };
}
