// In-memory GitHubAdapter implementation for command-level tests. Mocked at
// the adapter boundary by design; every result is deterministic. Labeled
// "MOCK" in descriptions so no one mistakes it for live data.
import type {
  GitHubAdapter,
  GitHubUser,
  RepoInfo,
  BranchProtectionInfo,
  PullRequest,
  CheckRun,
} from "../../src/core/github.js";

export class FakeGitHubAdapter implements GitHubAdapter {
  calls: Array<{ method: string; args: unknown[] }> = [];
  user: GitHubUser;
  repo: RepoInfo;
  protection: BranchProtectionInfo | null;
  prs: PullRequest[] = [];
  checksByHead = new Map<string, CheckRun[]>();
  reviewDecisions = new Map<number, PullRequest["reviewDecision"]>();
  autoMergeCalls: Array<{ number: number; method: string }> = [];
  failNext: { times: number; errorFactory: () => Error } | null = null;

  constructor(overrides: Partial<RepoInfo> = {}, login = "alice") {
    this.user = { login, name: "Alice" };
    this.repo = {
      nameWithOwner: "example/demo",
      defaultBranch: "main",
      allowAutoMerge: true,
      allowSquashMerge: true,
      allowMergeCommit: true,
      allowRebaseMerge: true,
      allowUpdateBranch: true,
      deleteBranchOnMerge: true,
      hasIssues: true,
      isPrivate: false,
      viewerPermission: "write",
      mergeQueueEnabled: "unknown",
      ...overrides,
    };
    this.protection = { requiredChecks: ["integration"], requireUpToDateBranch: true, requiredReviews: 0 };
  }

  private async maybeFail(): Promise<void> {
    if (this.failNext && this.failNext.times > 0) {
      this.failNext.times -= 1;
      throw this.failNext.errorFactory();
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return true; // MOCK
  }

  async whoAmI(): Promise<GitHubUser> {
    await this.maybeFail();
    this.calls.push({ method: "whoAmI", args: [] });
    return this.user;
  }

  async ping(): Promise<void> {
    this.calls.push({ method: "ping", args: [] });
  }

  async getRepo(): Promise<RepoInfo> {
    await this.maybeFail();
    this.calls.push({ method: "getRepo", args: [] });
    return this.repo;
  }

  async getBranchProtection(): Promise<BranchProtectionInfo | null> {
    this.calls.push({ method: "getBranchProtection", args: [] });
    return this.protection;
  }

  async listOpenPRs(): Promise<PullRequest[]> {
    await this.maybeFail();
    this.calls.push({ method: "listOpenPRs", args: [] });
    return this.prs.filter((p) => p.state === "open");
  }

  async getPull(_o: string, _r: string, number: number): Promise<PullRequest> {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`MOCK: no PR #${number}`);
    return pr;
  }

  async findPRByHead(_o: string, _r: string, headRefName: string): Promise<PullRequest | null> {
    this.calls.push({ method: "findPRByHead", args: [headRefName] });
    return this.prs.find((p) => p.headRefName === headRefName && p.state === "open") ?? null;
  }

  async createPull(
    _o: string,
    _r: string,
    input: { head: string; base: string; title: string; body: string; draft?: boolean },
  ): Promise<PullRequest> {
    await this.maybeFail();
    this.calls.push({ method: "createPull", args: [input] });
    const number = this.prs.length + 1;
    const pr: PullRequest = {
      nodeId: `PR_${number}`,
      number,
      url: `https://github.com/example/demo/pull/${number}`,
      title: input.title,
      state: "open",
      draft: input.draft === true,
      headRefName: input.head,
      headRefOid: "abc1230000000000000000000000000000000000",
      baseRefName: input.base,
      baseRefOid: "def4560000000000000000000000000000000000",
      mergeable: null,
      mergeStateStatus: "UNKNOWN",
      autoMerge: null,
      reviewDecision: null,
      authorLogin: this.user.login,
    };
    this.prs.push(pr);
    return pr;
  }

  async updatePullBody(_o: string, _r: string, number: number, _body: string): Promise<void> {
    this.calls.push({ method: "updatePullBody", args: [number] });
  }

  async enableAutoMerge(_o: string, _r: string, number: number, method: "merge" | "squash" | "rebase"): Promise<void> {
    await this.maybeFail();
    this.calls.push({ method: "enableAutoMerge", args: [number, method] });
    this.autoMergeCalls.push({ number, method });
    const pr = this.prs.find((p) => p.number === number);
    if (pr) pr.autoMerge = { enabledBy: this.user.login, mergeMethod: method };
  }

  async getChecks(_o: string, _r: string, headSha: string): Promise<CheckRun[]> {
    this.calls.push({ method: "getChecks", args: [headSha] });
    return this.checksByHead.get(headSha) ?? [];
  }

  async getReviewDecision(_o: string, _r: string, number: number): Promise<PullRequest["reviewDecision"]> {
    return this.reviewDecisions.get(number) ?? null;
  }
}
