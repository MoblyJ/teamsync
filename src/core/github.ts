// GitHub adapter boundary. Everything GitHub-specific lives behind this
// interface; the GhCliAdapter shells out to `gh api` (authentication delegated
// to `gh auth login`, never handled here). Tests mock this interface and label
// mocked results. Replaceable later by direct OAuth device-flow auth.
import { run, executableName, ProcessError } from "./proc.js";
import { authError, networkError, notFoundError, blockedError, TeamsyncError, ExitCode } from "./errors.js";
import { redact } from "./redact.js";

const GH = executableName("gh");

export interface GitHubUser {
  login: string;
  name?: string;
}

export type ViewerPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none" | "unknown";

export interface RepoInfo {
  nameWithOwner: string;
  defaultBranch: string;
  /** Repository settings — capabilities we discover, never assume. */
  allowAutoMerge: boolean;
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
  allowUpdateBranch: boolean;
  deleteBranchOnMerge: boolean;
  hasIssues: boolean;
  isPrivate: boolean;
  viewerPermission: ViewerPermission;
  /** Merge queue configured on the default branch: not discoverable via public API without admin; "unknown" is honest. */
  mergeQueueEnabled: boolean | "unknown";
}

export type MergeStateStatus =
  | "CLEAN" | "BLOCKED" | "BEHIND" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNSTABLE" | "UNKNOWN";

export interface PullRequest {
  nodeId: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  /** null = GitHub still computing mergeability. */
  mergeable: boolean | null;
  mergeStateStatus: MergeStateStatus;
  /** Present when auto-merge is enabled on this PR. */
  autoMerge: { enabledBy: string; mergeMethod: "merge" | "squash" | "rebase" } | null;
  /** null when reviews not required or not fetched. */
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | null;
  authorLogin: string;
}

export interface CheckRun {
  name: string;
  source: "actions" | "status";
  /** Normalized state — "skipped" is deliberately distinct from success. */
  state: CheckState;
  headSha: string;
  startedAt?: string;
  detailsUrl?: string;
}

export type CheckState = "success" | "failure" | "pending" | "skipped" | "cancelled" | "missing" | "neutral";

export interface BranchProtectionInfo {
  requiredChecks: string[];
  requireUpToDateBranch: boolean | "unknown";
  requiredReviews: number | "unknown";
}

/** Options for query params / request body. */
export interface ApiRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Raw (unescaped) query params, rendered as -f key=value. */
  rawParams?: Record<string, string>;
  /** Typed params rendered as -F key=value (numbers, booleans become literals). */
  typedParams?: Record<string, string | number | boolean>;
  /** JSON request body sent via stdin (POST/PATCH). */
  body?: unknown;
  /** Follow pagination, merging array results. */
  paginate?: boolean;
}

/**
 * The complete GitHub surface the CLI needs. Adapters throw TeamsyncError
 * with actionable hints and never leak tokens.
 */
export interface GitHubAdapter {
  isAuthenticated(): Promise<boolean>;
  whoAmI(): Promise<GitHubUser>;
  ping(): Promise<void>;
  getRepo(owner: string, repo: string): Promise<RepoInfo>;
  getBranchProtection(owner: string, repo: string, branch: string): Promise<BranchProtectionInfo | null>;
  listOpenPRs(owner: string, repo: string): Promise<PullRequest[]>;
  getPull(owner: string, repo: string, number: number): Promise<PullRequest>;
  findPRByHead(owner: string, repo: string, headRefName: string): Promise<PullRequest | null>;
  createPull(
    owner: string,
    repo: string,
    input: { head: string; base: string; title: string; body: string; draft?: boolean },
  ): Promise<PullRequest>;
  updatePullBody(owner: string, repo: string, number: number, body: string): Promise<void>;
  enableAutoMerge(
    owner: string,
    repo: string,
    number: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<void>;
  getChecks(owner: string, repo: string, headSha: string): Promise<CheckRun[]>;
  /** GraphQL-only field: overall review decision. Null when unavailable. */
  getReviewDecision(owner: string, repo: string, number: number): Promise<PullRequest["reviewDecision"]>;
}

// ---------------------------------------------------------------------------
// Error mapping from `gh` output to actionable TeamsyncErrors.
// ---------------------------------------------------------------------------

export function mapGhError(stderrText: string, context: string): TeamsyncError {
  const text = redact(stderrText);
  const httpMatch = /\(HTTP (\d{3})[^)]*\)/.exec(text);
  const status = httpMatch ? Number(httpMatch[1]) : undefined;

  if (/Bad credentials|HTTP 401|401 Unauthorized/i.test(text)) {
    return authError(`${context}: GitHub rejected the stored credentials (401).`, [
      "Your gh login likely expired. Run `teamsync login` to refresh it.",
    ]);
  }
  if (/API rate limit exceeded|secondary rate limit|HTTP 429/i.test(text)) {
    return networkError(`${context}: GitHub API rate limit reached.`, [
      "Wait for the rate limit window to reset, then retry.",
      "`teamsync watch` backs off automatically; avoid tight polling loops.",
    ]);
  }
  if (/HTTP 404|Not Found/i.test(text) && status !== 403) {
    return notFoundError(`${context}: not found (404).`, [
      "Check OWNER/REPO spelling and that your account has access to the repository.",
      "Private repositories require membership; `teamsync join` never grants access.",
    ]);
  }
  if (status === 403 || /HTTP 403|Resource not accessible by integration|Must have admin rights/i.test(text)) {
    return blockedError(`${context}: GitHub refused the request (403).`, [
      "Your account likely lacks the permission required for this operation.",
      "If this needs admin rights (settings/protection), ask a repository admin instead of retrying.",
    ]);
  }
  if (status === 422 || /HTTP 422/i.test(text)) {
    return new TeamsyncError({
      message: `${context}: GitHub rejected the request (422): ${text.slice(0, 300)}`,
      code: "github-validation",
      exitCode: ExitCode.GENERAL,
      hints: ["Read the message for the failing field (branch names, duplicates, etc.)."],
    });
  }
  if (/^\s*$/.test(text) || /dial tcp|no such host|connection refused|Could not resolve|TLS handshake|i\/o timeout/i.test(text)) {
    return networkError(`${context}: network error. ${text.slice(0, 200)}`, [
      "Check your internet connection, then retry.",
    ]);
  }
  return new TeamsyncError({
    message: `${context}: gh api failed: ${text.slice(0, 400)}`,
    code: "github",
    exitCode: ExitCode.GENERAL,
    hints: ["Run `gh auth status` to check authentication."],
  });
}

export class GhNotInstalledError extends TeamsyncError {
  constructor() {
    super({
      message: "GitHub CLI (`gh`) is not installed or not on PATH.",
      code: "gh-missing",
      exitCode: ExitCode.UNSUPPORTED,
      hints: [
        "Install gh from https://cli.github.com/ (macOS: brew install gh, Windows: winget install GitHub.cli, Debian/Ubuntu: apt install gh).",
        "Then run `teamsync login`.",
      ],
    });
  }
}

function buildApiArgs(restPath: string, req: ApiRequest): string[] {
  const args = ["api", restPath];
  if (req.method && req.method !== "GET") args.push("--method", req.method);
  for (const [k, v] of Object.entries(req.rawParams ?? {})) args.push("-f", `${k}=${v}`);
  for (const [k, v] of Object.entries(req.typedParams ?? {})) args.push("-F", `${k}=${v}`);
  if (req.paginate) args.push("--paginate");
  if (req.body !== undefined) args.push("--input", "-");
  return args;
}

/** Run `gh api` and parse JSON stdout. Throws mapped TeamsyncError on failure. */
export async function ghApi<T>(
  args: readonly string[],
  opts: { cwd?: string; input?: string; ghPath?: string; timeoutMs?: number } = {},
): Promise<T> {
  let res;
  try {
    res = await run(opts.ghPath ?? GH, args, { cwd: opts.cwd, input: opts.input, timeoutMs: opts.timeoutMs });
  } catch (err) {
    if (err instanceof ProcessError && /ENOENT|not found/i.test(err.message)) throw new GhNotInstalledError();
    throw err;
  }
  if (!res.ok) throw mapGhError(res.stderr || res.stdout, `gh ${args[0]} ${args[1] ?? ""}`.trim());
  if (res.stdout.trim() === "") return undefined as T;
  return JSON.parse(res.stdout) as T;
}

// ---------------------------------------------------------------------------
// REST/GraphQL response shapes (only fields we consume).
// ---------------------------------------------------------------------------

interface RestRepo {
  full_name: string;
  default_branch: string;
  private: boolean;
  has_issues: boolean;
  allow_auto_merge?: boolean;
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
  allow_update_branch?: boolean;
  delete_branch_on_merge?: boolean;
  viewer_permission?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

interface RestPull {
  node_id: string;
  number: number;
  html_url: string;
  title: string;
  state: string;
  draft?: boolean;
  user?: { login?: string };
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { ref: string; sha: string };
  mergeable: boolean | null;
  mergeable_state?: string;
  auto_merge?: { enabled_by?: { login?: string }; merge_method?: string } | null;
}

interface RestCheckRun {
  name: string;
  head_sha: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string;
  html_url?: string;
}

interface RestCombinedStatus {
  sha: string;
  statuses?: Array<{ state?: string; context?: string; target_url?: string }>;
}

interface RestProtection {
  required_status_checks?: { contexts?: string[]; checks?: Array<{ context: string }> } | null;
  required_pull_request_reviews?: { required_approving_review_count?: number } | null;
  strict?: boolean;
}

const MERGE_STATE_MAP: Record<string, MergeStateStatus> = {
  clean: "CLEAN",
  blocked: "BLOCKED",
  behind: "BEHIND",
  dirty: "DIRTY",
  draft: "DRAFT",
  has_hooks: "HAS_HOOKS",
  unstable: "UNSTABLE",
};

function normalizeCheckState(conclusion: string | null | undefined, status: string | undefined): CheckState {
  const c = (conclusion ?? "").toLowerCase();
  switch (c) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "neutral":
      return "neutral";
    case "":
    case null:
    case undefined: {
      const s = (status ?? "").toLowerCase();
      return s === "completed" ? "missing" : "pending";
    }
    default: {
      const s = (status ?? "").toLowerCase();
      return s === "completed" ? "missing" : "pending";
    }
  }
}

function normalizeStatusState(state: string | undefined): CheckState {
  switch ((state ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "expected":
    case "pending":
      return "pending";
    default:
      return "missing";
  }
}

function restToPull(p: RestPull): PullRequest {
  return {
    nodeId: p.node_id,
    number: p.number,
    url: p.html_url,
    title: p.title,
    state: p.state === "closed" ? "closed" : "open",
    draft: p.draft === true,
    headRefName: p.head.ref,
    headRefOid: p.head.sha,
    baseRefName: p.base.ref,
    baseRefOid: p.base.sha,
    mergeable: p.mergeable,
    mergeStateStatus: MERGE_STATE_MAP[(p.mergeable_state ?? "").toLowerCase()] ?? "UNKNOWN",
    autoMerge: p.auto_merge
      ? {
          enabledBy: p.auto_merge.enabled_by?.login ?? "unknown",
          mergeMethod: (p.auto_merge.merge_method ?? "squash") as "merge" | "squash" | "rebase",
        }
      : null,
    reviewDecision: null,
    authorLogin: p.user?.login ?? "unknown",
  };
}

// ---------------------------------------------------------------------------
// The gh CLI implementation.
// ---------------------------------------------------------------------------

export class GhCliAdapter implements GitHubAdapter {
  constructor(
    private readonly opts: { cwd?: string; ghPath?: string; timeoutMs?: number } = {},
  ) {}

  private api<T>(restPath: string, req: ApiRequest = {}): Promise<T> {
    return ghApi<T>(buildApiArgs(restPath, req), {
      cwd: this.opts.cwd,
      ghPath: this.opts.ghPath,
      timeoutMs: this.opts.timeoutMs,
      ...(req.body !== undefined ? { input: JSON.stringify(req.body) } : {}),
    });
  }

  private graphql<T>(query: string, variables: Record<string, string | number>): Promise<T> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(variables)) {
      if (typeof v === "number") args.push("-F", `${k}=${v}`);
      else args.push("-f", `${k}=${v}`);
    }
    return ghApi<T>(args, { cwd: this.opts.cwd, ghPath: this.opts.ghPath, timeoutMs: this.opts.timeoutMs });
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.whoAmI();
      return true;
    } catch {
      return false;
    }
  }

  async whoAmI(): Promise<GitHubUser> {
    const u = await this.api<{ login: string; name?: string }>("user");
    return { login: u.login, ...(u.name ? { name: u.name } : {}) };
  }

  async ping(): Promise<void> {
    await this.api<unknown>("rate_limit");
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const r = await this.api<RestRepo>(`repos/${owner}/${repo}`);
    const perm = (r.viewer_permission ?? "").toLowerCase();
    const viewerPermission: ViewerPermission = (
      ["admin", "maintain", "write", "triage", "read", "none"] as const
    ).includes(perm as Exclude<ViewerPermission, "unknown">)
      ? (perm as ViewerPermission)
      : r.permissions?.push
        ? "write"
        : "unknown";
    return {
      nameWithOwner: r.full_name,
      defaultBranch: r.default_branch,
      allowAutoMerge: r.allow_auto_merge === true,
      allowSquashMerge: r.allow_squash_merge !== false,
      allowMergeCommit: r.allow_merge_commit !== false,
      allowRebaseMerge: r.allow_rebase_merge !== false,
      allowUpdateBranch: r.allow_update_branch === true,
      deleteBranchOnMerge: r.delete_branch_on_merge === true,
      hasIssues: r.has_issues,
      isPrivate: r.private === true,
      viewerPermission,
      // Honest default: merge-queue status isn't readable without admin; see README.
      mergeQueueEnabled: "unknown",
    };
  }

  async getBranchProtection(owner: string, repo: string, branch: string): Promise<BranchProtectionInfo | null> {
    // Requires admin/maintain. 403/404 for others → null ("unknown") by design.
    try {
      const p = await this.api<RestProtection>(`repos/${owner}/${repo}/branches/${branch}/protection`);
      const contexts = new Set<string>();
      for (const c of p.required_status_checks?.contexts ?? []) contexts.add(c);
      for (const c of p.required_status_checks?.checks ?? []) contexts.add(c.context);
      return {
        requiredChecks: [...contexts],
        requireUpToDateBranch: p.strict === true,
        requiredReviews: p.required_pull_request_reviews?.required_approving_review_count ?? 0,
      };
    } catch (err) {
      if (err instanceof TeamsyncError) return null;
      throw err;
    }
  }

  async listOpenPRs(owner: string, repo: string): Promise<PullRequest[]> {
    const prs = await this.api<RestPull[]>(`repos/${owner}/${repo}/pulls`, {
      rawParams: { state: "open" },
      typedParams: { per_page: 100 },
      paginate: true,
    });
    return (prs ?? []).map(restToPull);
  }

  async getPull(owner: string, repo: string, number: number): Promise<PullRequest> {
    return restToPull(await this.api<RestPull>(`repos/${owner}/${repo}/pulls/${number}`));
  }

  async findPRByHead(owner: string, repo: string, headRefName: string): Promise<PullRequest | null> {
    const prs = await this.listOpenPRs(owner, repo);
    return prs.find((p) => p.headRefName === headRefName) ?? null;
  }

  async createPull(
    owner: string,
    repo: string,
    input: { head: string; base: string; title: string; body: string; draft?: boolean },
  ): Promise<PullRequest> {
    try {
      return restToPull(await this.api<RestPull>(`repos/${owner}/${repo}/pulls`, { method: "POST", body: input }));
    } catch (err) {
      // Idempotency: a retry after a lost response must not duplicate PRs.
      if (err instanceof TeamsyncError && /already exists/i.test(err.message)) {
        const existing = await this.findPRByHead(owner, repo, input.head);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async updatePullBody(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.api<unknown>(`repos/${owner}/${repo}/pulls/${number}`, { method: "PATCH", body: { body } });
  }

  async enableAutoMerge(
    owner: string,
    repo: string,
    number: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<void> {
    const q = await this.graphql<{ repository: { pullRequest: { id: string } | null } | null }>(
      "query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){id}}}",
      { o: owner, n: repo, num: number },
    );
    const nodeId = q.repository?.pullRequest?.id;
    if (!nodeId) {
      throw notFoundError(`PR #${number} in ${owner}/${repo} disappeared while enabling auto-merge.`, [
        "Refresh with `teamsync status`.",
      ]);
    }
    const METHOD = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" } as const;
    await this.graphql<unknown>(
      "mutation($id:ID!,$m:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){pullRequest{number}}}",
      { id: nodeId, m: METHOD[method] },
    );
  }

  async getReviewDecision(owner: string, repo: string, number: number): Promise<PullRequest["reviewDecision"]> {
    try {
      const q = await this.graphql<{
        repository: { pullRequest: { reviewDecision: string | null } | null } | null;
      }>(
        "query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){reviewDecision}}}",
        { o: owner, n: repo, num: number },
      );
      const rd = q.repository?.pullRequest?.reviewDecision ?? null;
      if (rd === "APPROVED" || rd === "REVIEW_REQUIRED" || rd === "CHANGES_REQUESTED") return rd;
      return null;
    } catch (err) {
      if (err instanceof TeamsyncError) return null; // degrade gracefully in status views
      throw err;
    }
  }

  async getChecks(owner: string, repo: string, headSha: string): Promise<CheckRun[]> {
    const runs = await this.api<{ total_count: number; check_runs: RestCheckRun[] }>(
      `repos/${owner}/${repo}/commits/${headSha}/check-runs`,
      { typedParams: { per_page: 100 } },
    );
    const checks: CheckRun[] = (runs.check_runs ?? []).map((c) => ({
      name: c.name,
      source: "actions" as const,
      state: normalizeCheckState(c.conclusion, c.status),
      headSha: c.head_sha,
      ...(c.started_at ? { startedAt: c.started_at } : {}),
      ...(c.html_url ? { detailsUrl: c.html_url } : {}),
    }));
    // Commit statuses (external CI) count as checks too; optional endpoint.
    try {
      const combined = await this.api<RestCombinedStatus>(`repos/${owner}/${repo}/commits/${headSha}/status`);
      for (const s of combined.statuses ?? []) {
        if (!s.context) continue;
        checks.push({
          name: s.context,
          source: "status" as const,
          state: normalizeStatusState(s.state),
          headSha: combined.sha,
          ...(s.target_url ? { detailsUrl: s.target_url } : {}),
        });
      }
    } catch {
      // ignore — check-runs already collected
    }
    return checks;
  }
}
