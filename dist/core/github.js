// GitHub adapter boundary. Everything GitHub-specific lives behind this
// interface; the GhCliAdapter shells out to `gh api` (authentication delegated
// to `gh auth login`, never handled here). Tests mock this interface and label
// mocked results. Replaceable later by direct OAuth device-flow auth.
import { run, executableName, ProcessError } from "./proc.js";
import { authError, networkError, notFoundError, blockedError, TeamsyncError, ExitCode } from "./errors.js";
import { redact } from "./redact.js";
const GH = executableName("gh");
// ---------------------------------------------------------------------------
// Error mapping from `gh` output to actionable TeamsyncErrors.
// ---------------------------------------------------------------------------
export function mapGhError(stderrText, context) {
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
function buildApiArgs(restPath, req) {
    const args = ["api", restPath];
    if (req.method && req.method !== "GET")
        args.push("--method", req.method);
    for (const [k, v] of Object.entries(req.rawParams ?? {}))
        args.push("-f", `${k}=${v}`);
    for (const [k, v] of Object.entries(req.typedParams ?? {}))
        args.push("-F", `${k}=${v}`);
    if (req.paginate)
        args.push("--paginate");
    if (req.body !== undefined)
        args.push("--input", "-");
    return args;
}
/** Run `gh api` and parse JSON stdout. Throws mapped TeamsyncError on failure. */
export async function ghApi(args, opts = {}) {
    let res;
    try {
        res = await run(opts.ghPath ?? GH, args, { cwd: opts.cwd, input: opts.input, timeoutMs: opts.timeoutMs });
    }
    catch (err) {
        if (err instanceof ProcessError && /ENOENT|not found/i.test(err.message))
            throw new GhNotInstalledError();
        throw err;
    }
    if (!res.ok)
        throw mapGhError(res.stderr || res.stdout, `gh ${args[0]} ${args[1] ?? ""}`.trim());
    if (res.stdout.trim() === "")
        return undefined;
    return JSON.parse(res.stdout);
}
const MERGE_STATE_MAP = {
    clean: "CLEAN",
    blocked: "BLOCKED",
    behind: "BEHIND",
    dirty: "DIRTY",
    draft: "DRAFT",
    has_hooks: "HAS_HOOKS",
    unstable: "UNSTABLE",
};
function normalizeCheckState(conclusion, status) {
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
function normalizeStatusState(state) {
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
function restToPull(p) {
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
                mergeMethod: (p.auto_merge.merge_method ?? "squash"),
            }
            : null,
        reviewDecision: null,
        authorLogin: p.user?.login ?? "unknown",
    };
}
// ---------------------------------------------------------------------------
// The gh CLI implementation.
// ---------------------------------------------------------------------------
export class GhCliAdapter {
    opts;
    constructor(opts = {}) {
        this.opts = opts;
    }
    api(restPath, req = {}) {
        return ghApi(buildApiArgs(restPath, req), {
            cwd: this.opts.cwd,
            ghPath: this.opts.ghPath,
            timeoutMs: this.opts.timeoutMs,
            ...(req.body !== undefined ? { input: JSON.stringify(req.body) } : {}),
        });
    }
    graphql(query, variables) {
        const args = ["api", "graphql", "-f", `query=${query}`];
        for (const [k, v] of Object.entries(variables)) {
            if (typeof v === "number")
                args.push("-F", `${k}=${v}`);
            else
                args.push("-f", `${k}=${v}`);
        }
        return ghApi(args, { cwd: this.opts.cwd, ghPath: this.opts.ghPath, timeoutMs: this.opts.timeoutMs });
    }
    async isAuthenticated() {
        try {
            await this.whoAmI();
            return true;
        }
        catch {
            return false;
        }
    }
    async whoAmI() {
        const u = await this.api("user");
        return { login: u.login, ...(u.name ? { name: u.name } : {}) };
    }
    async ping() {
        await this.api("rate_limit");
    }
    async getRepo(owner, repo) {
        const r = await this.api(`repos/${owner}/${repo}`);
        const perm = (r.viewer_permission ?? "").toLowerCase();
        const viewerPermission = ["admin", "maintain", "write", "triage", "read", "none"].includes(perm)
            ? perm
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
    async getBranchProtection(owner, repo, branch) {
        // Requires admin/maintain. 403/404 for others → null ("unknown") by design.
        try {
            const p = await this.api(`repos/${owner}/${repo}/branches/${branch}/protection`);
            const contexts = new Set();
            for (const c of p.required_status_checks?.contexts ?? [])
                contexts.add(c);
            for (const c of p.required_status_checks?.checks ?? [])
                contexts.add(c.context);
            return {
                requiredChecks: [...contexts],
                requireUpToDateBranch: p.strict === true,
                requiredReviews: p.required_pull_request_reviews?.required_approving_review_count ?? 0,
            };
        }
        catch (err) {
            if (err instanceof TeamsyncError)
                return null;
            throw err;
        }
    }
    async listOpenPRs(owner, repo) {
        const prs = await this.api(`repos/${owner}/${repo}/pulls`, {
            rawParams: { state: "open" },
            typedParams: { per_page: 100 },
            paginate: true,
        });
        return (prs ?? []).map(restToPull);
    }
    async getPull(owner, repo, number) {
        return restToPull(await this.api(`repos/${owner}/${repo}/pulls/${number}`));
    }
    async findPRByHead(owner, repo, headRefName) {
        const prs = await this.listOpenPRs(owner, repo);
        return prs.find((p) => p.headRefName === headRefName) ?? null;
    }
    async createPull(owner, repo, input) {
        try {
            return restToPull(await this.api(`repos/${owner}/${repo}/pulls`, { method: "POST", body: input }));
        }
        catch (err) {
            // Idempotency: a retry after a lost response must not duplicate PRs.
            if (err instanceof TeamsyncError && /already exists/i.test(err.message)) {
                const existing = await this.findPRByHead(owner, repo, input.head);
                if (existing)
                    return existing;
            }
            throw err;
        }
    }
    async updatePullBody(owner, repo, number, body) {
        await this.api(`repos/${owner}/${repo}/pulls/${number}`, { method: "PATCH", body: { body } });
    }
    async enableAutoMerge(owner, repo, number, method) {
        const q = await this.graphql("query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){id}}}", { o: owner, n: repo, num: number });
        const nodeId = q.repository?.pullRequest?.id;
        if (!nodeId) {
            throw notFoundError(`PR #${number} in ${owner}/${repo} disappeared while enabling auto-merge.`, [
                "Refresh with `teamsync status`.",
            ]);
        }
        const METHOD = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" };
        await this.graphql("mutation($id:ID!,$m:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){pullRequest{number}}}", { id: nodeId, m: METHOD[method] });
    }
    async getReviewDecision(owner, repo, number) {
        try {
            const q = await this.graphql("query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){reviewDecision}}}", { o: owner, n: repo, num: number });
            const rd = q.repository?.pullRequest?.reviewDecision ?? null;
            if (rd === "APPROVED" || rd === "REVIEW_REQUIRED" || rd === "CHANGES_REQUESTED")
                return rd;
            return null;
        }
        catch (err) {
            if (err instanceof TeamsyncError)
                return null; // degrade gracefully in status views
            throw err;
        }
    }
    async getChecks(owner, repo, headSha) {
        const runs = await this.api(`repos/${owner}/${repo}/commits/${headSha}/check-runs`, { typedParams: { per_page: 100 } });
        const checks = (runs.check_runs ?? []).map((c) => ({
            name: c.name,
            source: "actions",
            state: normalizeCheckState(c.conclusion, c.status),
            headSha: c.head_sha,
            ...(c.started_at ? { startedAt: c.started_at } : {}),
            ...(c.html_url ? { detailsUrl: c.html_url } : {}),
        }));
        // Commit statuses (external CI) count as checks too; optional endpoint.
        try {
            const combined = await this.api(`repos/${owner}/${repo}/commits/${headSha}/status`);
            for (const s of combined.statuses ?? []) {
                if (!s.context)
                    continue;
                checks.push({
                    name: s.context,
                    source: "status",
                    state: normalizeStatusState(s.state),
                    headSha: combined.sha,
                    ...(s.target_url ? { detailsUrl: s.target_url } : {}),
                });
            }
        }
        catch {
            // ignore — check-runs already collected
        }
        return checks;
    }
}
