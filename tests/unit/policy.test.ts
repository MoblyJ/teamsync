// Unit tests — integration policy. These encode the merge-safety acceptance
// criteria: stale checks never pass, skipped ≠ success, conflicts stay
// blocked, base movement forces re-sync, reviews stay enforced, and manual
// mode is explicit. All inputs are MOCK fixtures.
import { describe, expect, it } from "vitest";
import { assessIntegration, type AssessInput } from "../../src/core/policy.js";
import type { CheckRun, PullRequest } from "../../src/core/github.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "1111111111111111111111111111111111111111";

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    nodeId: "PR_1",
    number: 1,
    url: "https://github.com/example/demo/pull/1",
    title: "Add homepage",
    state: "open",
    draft: false,
    headRefName: "teamsync/alice/frontend/homepage-a1b2c3",
    headRefOid: HEAD,
    baseRefName: "main",
    baseRefOid: "def4560000000000000000000000000000000000",
    mergeable: true,
    mergeStateStatus: "CLEAN",
    autoMerge: null,
    reviewDecision: null,
    authorLogin: "alice",
    ...overrides,
  };
}

function check(name: string, state: CheckRun["state"], headSha = HEAD): CheckRun {
  return { name, source: "actions", state, headSha };
}

function input(overrides: Partial<AssessInput> = {}): AssessInput {
  return {
    pr: pr(),
    checks: [check("integration", "success")],
    requiredChecks: ["integration"],
    repo: {
      allowAutoMerge: true,
      viewerPermission: "write",
      allowSquashMerge: true,
      allowMergeCommit: true,
      allowRebaseMerge: true,
    },
    autoMergeWanted: true,
    ...overrides,
  };
}

describe("assessIntegration — check semantics", () => {
  it("clean PR with passing required check and auto-merge engaged", () => {
    const a = assessIntegration(input({ pr: pr({ autoMerge: { enabledBy: "alice", mergeMethod: "squash" } }) }));
    expect(a.state).toBe("auto-merge-requested");
    expect(a.autoMergeRequested).toBe(true);
    expect(a.blockers).toHaveLength(0);
  });

  it("required check still running → checks-pending, never merged", () => {
    const a = assessIntegration(input({ checks: [check("integration", "pending")] }));
    expect(a.state).toBe("checks-pending");
    expect(a.blockers.some((b) => b.includes("integration"))).toBe(true);
  });

  it("failed required check → checks-failed with fix-and-push hint", () => {
    const a = assessIntegration(input({ checks: [check("integration", "failure")] }));
    expect(a.state).toBe("checks-failed");
    expect(a.hints.join(" ")).toMatch(/push again/i);
  });

  it("cancelled required check is NOT success", () => {
    const a = assessIntegration(input({ checks: [check("integration", "cancelled")] }));
    expect(a.state).toBe("checks-failed");
  });

  it("skipped required check is NOT success (requirement 5)", () => {
    const a = assessIntegration(input({ checks: [check("integration", "skipped")] }));
    expect(a.state).toBe("checks-blocked");
    expect(a.summary).toMatch(/not success|skipped/i);
    expect(a.hints.join(" ")).toMatch(/aggregate/i);
  });

  it("neutral required check is NOT success", () => {
    const a = assessIntegration(input({ checks: [check("integration", "neutral")] }));
    expect(a.state).toBe("checks-blocked");
  });

  it("missing required check (never ran) → checks-blocked with aggregate-gate hint", () => {
    const a = assessIntegration(input({ checks: [] }));
    expect(a.state).toBe("checks-blocked");
    expect(a.blockers.join(" ")).toMatch(/never|not reported/i);
    expect(a.hints.join(" ")).toMatch(/aggregate gate/i);
  });

  it("STALE: checks from an older revision never satisfy the gate (requirement 3)", () => {
    const a = assessIntegration(input({ checks: [check("integration", "success", OLD)] }));
    expect(a.state).toBe("checks-pending");
    expect(a.staleChecks).toBe(true);
    expect(a.blockers.join(" ")).toMatch(/older revision|fresh/i);
  });

  it("optional checks do not gate", () => {
    const a = assessIntegration(input({ checks: [check("integration", "success"), check("lint", "failure")] }));
    expect(a.state).not.toBe("checks-failed");
  });

  it("a mix of one passing and one failing required check fails", () => {
    const a = assessIntegration(
      input({ requiredChecks: ["integration", "e2e"], checks: [check("integration", "success"), check("e2e", "failure")] }),
    );
    expect(a.state).toBe("checks-failed");
    expect(a.blockers.join(" ")).toMatch(/e2e/);
  });
});

describe("assessIntegration — conflicts, base movement, reviews", () => {
  it("mergeable=false → conflict, blocked with recovery hints (requirement 4)", () => {
    const a = assessIntegration(input({ pr: pr({ mergeable: false }) }));
    expect(a.state).toBe("conflict");
    expect(a.blockers.length).toBeGreaterThan(0);
    expect(a.hints.join(" ")).toMatch(/teamsync sync/i);
  });

  it("mergeStateStatus DIRTY → conflict even while checks pass", () => {
    const a = assessIntegration(input({ pr: pr({ mergeStateStatus: "DIRTY" }) }));
    expect(a.state).toBe("conflict");
  });

  it("BEHIND base → needs synchronization and fresh checks (requirement 2)", () => {
    const a = assessIntegration(
      input({ pr: pr({ mergeStateStatus: "BEHIND" }), checks: [check("integration", "success")] }),
    );
    expect(a.state).toBe("behind");
    expect(a.summary).toMatch(/synchron|fresh/i);
  });

  it("conflict outranks failing checks (most blocking state reported)", () => {
    const a = assessIntegration(
      input({ pr: pr({ mergeable: false }), checks: [check("integration", "failure")] }),
    );
    expect(a.state).toBe("conflict");
  });

  it("review required blocks merge regardless of checks (requirement 6)", () => {
    const a = assessIntegration(
      input({ pr: pr({ reviewDecision: "REVIEW_REQUIRED" }), checks: [check("integration", "success")] }),
    );
    expect(a.state).toBe("needs-review");
  });

  it("CHANGES_REQUESTED blocks with a targeted hint", () => {
    const a = assessIntegration(
      input({ pr: pr({ reviewDecision: "CHANGES_REQUESTED" }), checks: [check("integration", "success")] }),
    );
    expect(a.state).toBe("needs-review");
    expect(a.blockers.join(" ")).toMatch(/reviewer requested changes/i);
  });

  it("approved reviews do not block", () => {
    const a = assessIntegration(
      input({
        pr: pr({ reviewDecision: "APPROVED", autoMerge: { enabledBy: "alice", mergeMethod: "squash" } }),
        checks: [check("integration", "success")],
      }),
    );
    expect(a.state).toBe("auto-merge-requested");
  });

  it("draft PRs are reported as drafts", () => {
    const a = assessIntegration(input({ pr: pr({ draft: true }) }));
    expect(a.state).toBe("draft");
  });
});

describe("assessIntegration — auto-merge capability discovery", () => {
  it("repo disallowing auto-merge → explicit manual mode, PR intact", () => {
    const a = assessIntegration(
      input({ repo: { allowAutoMerge: false, viewerPermission: "admin", allowSquashMerge: true, allowMergeCommit: true, allowRebaseMerge: true } }),
    );
    expect(a.state).toBe("manual-mode");
    expect(a.manualMode).toBe(true);
    expect(a.summary).toMatch(/allow auto-merge/i);
  });

  it("insufficient permission → manual mode with admin hint", () => {
    const a = assessIntegration(input({ repo: { allowAutoMerge: true, viewerPermission: "read", allowSquashMerge: true, allowMergeCommit: true, allowRebaseMerge: true } }));
    expect(a.state).toBe("manual-mode");
    expect(a.blockers.join(" ")).toMatch(/read/);
  });

  it("autoMergeWanted=false disables enrollment path entirely", () => {
    const a = assessIntegration(input({ autoMergeWanted: false }));
    expect(a.state).toBe("manual-mode");
  });

  it("BLOCKED state with all visible checks green is diagnosed, not called success", () => {
    const a = assessIntegration(input({ pr: pr({ mergeStateStatus: "BLOCKED" }), autoMergeEnrollAttempted: true }));
    expect(a.state).toBe("blocked");
    expect(a.blockers.join(" ")).toMatch(/blocked/i);
  });

  it("merged/closed PRs report merged", () => {
    const a = assessIntegration(input({ pr: pr({ state: "closed" }) }));
    expect(a.merged).toBe(true);
    expect(a.state).toBe("merged");
  });

  it("enroll attempted + everything green → auto-merge-requested", () => {
    const a = assessIntegration(input({ autoMergeEnrollAttempted: true }));
    expect(a.state).toBe("auto-merge-requested");
  });
});
